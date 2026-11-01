import { MarkdownView, TFile, TFolder, type App, type Editor } from "obsidian";
import {
  MarkdownView as TestView,
  TFile as TestFile,
  TFolder as TestFolder,
} from "../../../adapters/obsidian/plugin";
import { vi } from "vitest";
import { createObsidianInkImportPorts } from "../../../../src/obsidian/import/adapter";
import type { WorkScheduler } from "../../../../src/domain/scheduling/work-scheduler";
import { immediateWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";

export function importAdapterFixture(workScheduler: WorkScheduler = immediateWorkScheduler()) {
  const text = new Map<string, string>();
  const files = new Map<string, TFile>();
  const folders = new Map<string, TFolder>();
  const views: MarkdownView[] = [];
  const listeners = new Set<(file: TFile) => void>();
  const put = (path: string, content: string) => {
    const candidate: unknown = new TestFile(path, new TextEncoder().encode(content).byteLength);
    if (!(candidate instanceof TFile)) throw new Error("Invalid fixture file class.");
    const file = candidate;
    files.set(path, file);
    text.set(path, content);
    return file;
  };
  const readHook = vi.fn<() => void>();
  const processHook = vi.fn<() => void>();
  const trash = vi.fn(async (file: TFile) => {
    files.delete(file.path);
    text.delete(file.path);
  });
  const app = {
    vault: {
      getFiles: () => [...files.values()],
      getFileByPath: (path: string) => files.get(path) ?? null,
      getFolderByPath: (path: string) => folders.get(path) ?? null,
      getAbstractFileByPath: (path: string) => files.get(path) ?? folders.get(path) ?? null,
      read: async (file: TFile) => {
        readHook();
        return text.get(file.path)!;
      },
      create: async (path: string, content: string) => {
        if (files.has(path)) throw new Error("exists");
        return put(path, content);
      },
      createFolder: async (path: string) => {
        const folder: unknown = new TestFolder(path);
        if (!(folder instanceof TFolder)) throw new Error("Invalid fixture folder class.");
        folders.set(path, folder);
      },
      process: async (file: TFile, update: (current: string) => string) => {
        processHook();
        const next = update(text.get(file.path)!);
        text.set(file.path, next);
        file.stat.size = new TextEncoder().encode(next).byteLength;
        return next;
      },
      on: (_name: string, listener: (file: TFile) => void) => {
        listeners.add(listener);
        return listener;
      },
      offref: (listener: (file: TFile) => void) => listeners.delete(listener),
    },
    fileManager: {
      trashFile: trash,
      generateMarkdownLink: (file: TFile, _source: string, _subpath?: string, alias?: string) =>
        `[[${file.path}${alias === undefined ? "" : `|${alias}`}]]`,
    },
    workspace: {
      iterateAllLeaves: (visit: (leaf: { view: MarkdownView }) => void) =>
        views.forEach((view) => visit({ view })),
      getLeavesOfType: () => views.map((view) => ({ view })),
    },
    metadataCache: {
      getFirstLinkpathDest: (link: string) => files.get(link) ?? files.get(`${link}.svg`) ?? null,
    },
  } as unknown as App;
  const ports = createObsidianInkImportPorts({
    app,
    workScheduler,
    createRunId: () => "test-run",
    convert: async () => ({ svg: "converted", warnings: [] }),
  });
  return { app, ports, put, files, text, views, readHook, processHook, trash, listeners };
}

export function openNote(
  fixture: ReturnType<typeof importAdapterFixture>,
  path: string,
  initial: string,
  initialMode: "source" | "preview" = "source",
) {
  let current = initial;
  let mode = initialMode;
  const previewData = fixture.text.get(path)!;
  const candidate: unknown = new TestView();
  if (!(candidate instanceof MarkdownView)) throw new Error("Invalid fixture view class.");
  const view = candidate;
  view.file = fixture.files.get(path)!;
  const transaction = vi.fn(
    (tx: { changes: { from: { ch: number }; to: { ch: number }; text: string }[] }) => {
      for (const change of tx.changes)
        current = current.slice(0, change.from.ch) + change.text + current.slice(change.to.ch);
    },
  );
  view.editor = {
    getValue: () => current,
    offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
    transaction,
  } as unknown as Editor;
  const save = vi.fn(async () => {
    const saved = mode === "source" ? current : previewData;
    fixture.text.set(path, saved);
    fixture.files.get(path)!.stat.size = new TextEncoder().encode(saved).byteLength;
  });
  view.save = save;
  view.getMode = () => mode;
  view.getState = () => ({ file: path });
  fixture.views.push(view);
  return {
    view,
    transaction,
    save,
    setValue: (next: string) => {
      current = next;
    },
    setMode: (next: "source" | "preview") => {
      mode = next;
    },
  };
}
