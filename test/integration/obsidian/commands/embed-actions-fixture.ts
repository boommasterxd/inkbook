import type { App, Editor, FileManager, MetadataCache, Vault } from "obsidian";
import { vi } from "vitest";

import { ObsidianEmbedActions } from "../../../../src/obsidian/commands/embed-actions";
import { ObsidianVaultFileAdapter } from "../../../../src/obsidian/vault/file-adapter";
import { ObsidianLinkAdapter } from "../../../../src/obsidian/vault/links";
import { ObsidianManagedFileAdapter } from "../../../../src/obsidian/vault/managed-files";
import { fakeObsidianFileClasses, FakeObsidianFile } from "../../../fixtures/obsidian/vault-files";

class FakeEditor {
  #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  getValue(): string {
    return this.#value;
  }

  getRange(from: { line: number; ch: number }, to: { line: number; ch: number }): string {
    return this.#value.slice(this.offsetAt(from), this.offsetAt(to));
  }

  offsetToPos(offset: number): { line: number; ch: number } {
    const prefix = this.#value.slice(0, offset);
    const lines = prefix.split("\n");
    return { ch: (lines[lines.length - 1] ?? "").length, line: lines.length - 1 };
  }

  replaceRange(replacement: string, from: { line: number; ch: number }, to = from): void {
    const start = this.offsetAt(from);
    const end = this.offsetAt(to);
    this.#value = `${this.#value.slice(0, start)}${replacement}${this.#value.slice(end)}`;
  }

  value(): string {
    return this.#value;
  }

  private offsetAt(position: { line: number; ch: number }): number {
    const lines = this.#value.split("\n");
    let offset = 0;
    for (let line = 0; line < position.line; line += 1) {
      offset += (lines[line] ?? "").length + 1;
    }
    return offset + position.ch;
  }
}

interface HarnessOptions {
  readonly documentText?: string;
  readonly editorAvailable?: boolean;
  readonly metadataResolved?: boolean;
  readonly ownerWindowAvailable?: boolean;
  readonly references?: number;
}

function linkTargetResolver(...files: readonly FakeObsidianFile[]) {
  const targets = new Map(files.map((file) => [file.path, file]));
  return vi.fn((linkpath: string) => targets.get(linkpath) ?? null);
}

export function createHarness(options: HarnessOptions = {}) {
  const source = new FakeObsidianFile("notes/note.md");
  const target = new FakeObsidianFile("drawings/page.svg");
  const recovered = new FakeObsidianFile("drawings/recovered.svg");
  let vaultText = options.documentText ?? "!inkbook[[drawings/page.svg]]";
  source.stat.size = new TextEncoder().encode(vaultText).byteLength;
  const editor = new FakeEditor(vaultText);
  const writeText = vi.fn(async (_text: string) => undefined);
  const confirm = vi.fn(() => true);
  const ownerWindow = {
    confirm,
    navigator: { clipboard: { writeText } },
  } as unknown as Window;
  const view = {
    containerEl: {
      ownerDocument: {
        defaultView: options.ownerWindowAvailable === false ? undefined : ownerWindow,
      },
    },
    ...(options.editorAvailable === false ? {} : { editor: editor as unknown as Editor }),
    file: source,
  };
  const metadataCache = {
    getFirstLinkpathDest: linkTargetResolver(target, recovered),
    resolvedLinks: {
      [source.path]: { [target.path]: 1 },
      ...((options.references ?? 1) > 1
        ? { "notes/other.md": { [target.path]: (options.references ?? 1) - 1 } }
        : {}),
    },
  };
  let metadataResolved = options.metadataResolved ?? true;
  const generateMarkdownLink = vi.fn((file: { readonly path: string }) => `[[${file.path}]]`);
  const trashFile = vi.fn(async () => undefined);
  let beforeProcess: (() => void) | undefined;
  const read = vi.fn(async () => vaultText);
  const process = vi.fn(async (_file: unknown, update: (current: string) => string) => {
    const pending = beforeProcess;
    beforeProcess = undefined;
    pending?.();
    vaultText = update(vaultText);
    source.stat.size = new TextEncoder().encode(vaultText).byteLength;
    return vaultText;
  });
  const vault = {
    getFileByPath: (path: string) => {
      if (path === source.path) return source;
      if (path === target.path) return target;
      if (path === recovered.path) return recovered;
      return null;
    },
    process,
    read,
  } as unknown as Vault;
  const files = new ObsidianVaultFileAdapter(vault, fakeObsidianFileClasses, (path) => path);
  const links = new ObsidianLinkAdapter({
    classes: fakeObsidianFileClasses,
    fileManager: { generateMarkdownLink } as unknown as FileManager,
    files,
    metadataCache: metadataCache as unknown as MetadataCache,
    normalizePath: (path) => path,
    resolution: { isResolved: () => metadataResolved },
  });
  const managedFiles = new ObsidianManagedFileAdapter(
    { trashFile } as unknown as FileManager,
    files,
    (path) => path,
  );
  const app = {
    workspace: { getActiveViewOfType: vi.fn(() => view) },
  } as unknown as App;
  const actions = new ObsidianEmbedActions({ app, files, links, managedFiles });
  return {
    actions,
    confirm,
    editor,
    generateMarkdownLink,
    metadataCache,
    process,
    read,
    setBeforeProcess: (callback: () => void) => {
      beforeProcess = callback;
    },
    setMetadataResolved: (resolved: boolean) => {
      metadataResolved = resolved;
    },
    setVaultText: (text: string) => {
      vaultText = text;
      source.stat.size = new TextEncoder().encode(vaultText).byteLength;
    },
    trashFile,
    vaultText: () => vaultText,
    writeText,
  };
}
