import { TFile, type App, type Editor, type MarkdownFileInfo } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { createBuiltInSettings } from "../../../../src/domain/settings";
import type { FilePlacementV1 } from "../../../../src/domain/settings/types";
import {
  createObsidianInsertionController,
  EmptyLineInsertionController,
  isEmptyInsertionLine,
  PenTapInsertionController,
  type CompletedEmptyLineInsertion,
  type EmptyLineInsertionNotifications,
  type PenTapPointerSample,
} from "../../../../src/obsidian/commands";
import type { InkbookSettingsStore } from "../../../../src/obsidian/settings";

import { FakeEditor, registerInsertion } from "./insertion-command-fixture";

const TestTFile = TFile as unknown as new (path: string, size?: number) => TFile;
type MemoryVaultFiles = Map<string, { readonly file: TFile; readonly text: string }>;

function createHarness(editor: FakeEditor) {
  const insertions: CompletedEmptyLineInsertion[] = [];
  const failed = vi.fn();
  const notifications: EmptyLineInsertionNotifications = {
    failed,
    inserted: (insertion) => insertions.push(insertion),
  };
  const create = vi.fn(async (_path: string, content: string) => ({ content }));
  const trash = vi.fn(async () => undefined);
  const controller = new EmptyLineInsertionController({
    documents: {
      prepare: async () => ({ content: "<svg />", path: "drawings/new.svg" }),
      verifyCreated: async () => true,
    },
    files: { createAndReadBack: create },
    links: { generateEmbed: () => "!inkbook[[../drawings/new.svg]]" },
    notifications,
    trash: { trash },
  });
  return {
    controller,
    create,
    editor: editor as unknown as Editor,
    failed,
    fakeEditor: editor,
    insertions,
    notifications,
    trash,
  };
}

interface FailedInsertionHarnessOptions {
  readonly editor?: FakeEditor;
  readonly prepare: () => Promise<{ readonly content: string; readonly path: string }>;
  readonly trashError?: Error;
  readonly verifyCreated: (content: string) => Promise<boolean>;
}

function createFailedInsertionHarness(options: FailedInsertionHarnessOptions) {
  const fakeEditor = options.editor ?? new FakeEditor([""]);
  const failed = vi.fn();
  const inserted = vi.fn();
  const trash = vi.fn(async () => {
    if (options.trashError !== undefined) throw options.trashError;
  });
  const controller = new EmptyLineInsertionController({
    documents: { prepare: options.prepare, verifyCreated: options.verifyCreated },
    files: { createAndReadBack: async (_path, content) => ({ content }) },
    links: { generateEmbed: () => "!inkbook[[new.svg]]" },
    notifications: { failed, inserted },
    trash: { trash },
  });
  return {
    controller,
    editor: fakeEditor as unknown as Editor,
    failed,
    fakeEditor,
    inserted,
    trash,
  };
}

function penSample(overrides: Partial<PenTapPointerSample> = {}): PenTapPointerSample {
  return {
    button: 0,
    buttons: 1,
    clientX: 20,
    clientY: 40,
    pointerId: 7,
    pointerType: "pen",
    timeStamp: 100,
    ...overrides,
  };
}

async function insertIntoEmptyEditor(): Promise<ReturnType<typeof createHarness>> {
  const harness = createHarness(new FakeEditor([""]));
  harness.controller.request(harness.editor, "page.md");
  await vi.waitFor(() => expect(harness.insertions).toHaveLength(1));
  return harness;
}

function createPenHarness(enabled = true) {
  const harness = createHarness(new FakeEditor([""]));
  return {
    harness,
    pen: new PenTapInsertionController(
      harness.controller,
      () => enabled,
      registerInsertion(harness.controller),
    ),
    target: {
      context: { file: { path: "page.md" } } as MarkdownFileInfo,
      editor: harness.editor,
      insideInkWidget: false,
      line: 0,
      sourcePath: "page.md",
    },
  };
}

function settingsForPlacement(filePlacement: FilePlacementV1): InkbookSettingsStore {
  return {
    getVaultSettings: () => ({
      ...createBuiltInSettings(),
      filePlacement,
    }),
  } as InkbookSettingsStore;
}

function activeWorkspace(ownerWindow: Window): App["workspace"] {
  return {
    getActiveViewOfType: () => ({
      containerEl: { ownerDocument: { defaultView: ownerWindow } },
    }),
  } as unknown as App["workspace"];
}

describe("empty Markdown line eligibility", () => {
  it("accepts a genuinely empty ordinary Markdown line", () => {
    const editor = new FakeEditor(["text", "", "more"]);
    expect(isEmptyInsertionLine(editor as unknown as Editor, 1)).toBe(true);
  });

  it("rejects whitespace, YAML frontmatter, and backtick code blocks", () => {
    expect(isEmptyInsertionLine(new FakeEditor(["  "]) as unknown as Editor, 0)).toBe(false);
    expect(
      isEmptyInsertionLine(
        new FakeEditor(["---", "title: Note", "", "---"]) as unknown as Editor,
        2,
      ),
    ).toBe(false);
    expect(isEmptyInsertionLine(new FakeEditor(["```ts", "", "```"]) as unknown as Editor, 1)).toBe(
      false,
    );
  });

  it("does not close a longer backtick fence with a shorter delimiter", () => {
    const editor = new FakeEditor(["````ts", "```", "", "````"]);
    expect(isEmptyInsertionLine(editor as unknown as Editor, 2)).toBe(false);
  });
});

describe("empty-line insertion", () => {
  it("creates the SVG before inserting a generated embed through Editor.replaceRange", async () => {
    const fake = new FakeEditor(["before", "", "after"], 1);
    const harness = createHarness(fake);

    expect(harness.controller.request(harness.editor, "notes/page.md")).toBe(true);
    expect(harness.controller.request(harness.editor, "notes/page.md")).toBe(false);
    await vi.waitFor(() => expect(harness.insertions).toHaveLength(1));

    expect(harness.create).toHaveBeenCalledWith("drawings/new.svg", "<svg />", expect.any(Number));
    expect(fake.lines).toEqual(["before", "", "", "!inkbook[[../drawings/new.svg]]", "", "after"]);
    expect(harness.insertions[0]?.line).toBe(3);
    expect(harness.trash).not.toHaveBeenCalled();
  });

  it.each([
    { lines: [""], line: 0, expected: ["", "", "EMBED", ""] },
    { lines: ["", "After"], line: 0, expected: ["", "", "EMBED", "", "After"] },
    { lines: ["Before", ""], line: 1, expected: ["Before", "", "", "EMBED", ""] },
    {
      lines: ["Before", "", "", "", "", "After"],
      line: 2,
      expected: ["Before", "", "", "EMBED", "", "After"],
    },
    { lines: ["", "", "", "", ""], line: 3, expected: ["", "", "EMBED", ""] },
  ])(
    "normalizes spacing and restores the original note on undo: $lines",
    async ({ lines, line, expected }) => {
      const fake = new FakeEditor([...lines], line);
      const harness = createHarness(fake);
      expect(harness.controller.request(harness.editor, "page.md")).toBe(true);
      await vi.waitFor(() => expect(harness.insertions).toHaveLength(1));
      expect(fake.lines).toEqual(
        expected.map((text) => (text === "EMBED" ? harness.insertions[0]?.embedMarkdown : text)),
      );
      expect(await harness.insertions[0]?.undo()).toBe(true);
      expect(fake.lines).toEqual(lines);
    },
  );

  it.each([
    { lines: [""], line: 0, changedLine: 0, text: "new text" },
    { lines: ["before", ""], line: 1, changedLine: 0, text: "```ts" },
    { lines: ["before", ""], line: 1, changedLine: 0, text: "---" },
  ])(
    "rechecks the target after preparation changes its context to $text",
    async ({ lines, line, changedLine, text }) => {
      let finishPreparation: ((value: { content: string; path: string }) => void) | undefined;
      const prepare = new Promise<{ content: string; path: string }>((resolve) => {
        finishPreparation = resolve;
      });
      const harness = createFailedInsertionHarness({
        editor: new FakeEditor(lines, line),
        prepare: () => prepare,
        verifyCreated: async () => true,
      });

      expect(harness.controller.request(harness.editor, "page.md")).toBe(true);
      harness.fakeEditor.lines[changedLine] = text;
      finishPreparation?.({ content: "<svg />", path: "new.svg" });
      await vi.waitFor(() => expect(harness.trash).toHaveBeenCalledWith("new.svg"));

      expect(harness.fakeEditor.lines[changedLine]).toBe(text);
      expect(harness.inserted).not.toHaveBeenCalled();
      expect(harness.failed).toHaveBeenCalledWith(
        "insertion-note-changed-cleaned",
        expect.any(Error),
      );
    },
  );

  it("trashes the created file and inserts no Markdown when worker verification fails", async () => {
    const harness = createFailedInsertionHarness({
      prepare: async () => ({ content: "<svg />", path: "new.svg" }),
      verifyCreated: async () => false,
    });

    expect(harness.controller.request(harness.editor, "page.md")).toBe(true);
    await vi.waitFor(() => expect(harness.failed).toHaveBeenCalledOnce());

    expect(harness.fakeEditor.lines[0]).toBe("");
    expect(harness.inserted).not.toHaveBeenCalled();
    expect(harness.trash).toHaveBeenCalledWith("new.svg");
  });

  it("undoes only an unchanged insertion and uses the recoverable trash boundary", async () => {
    const harness = await insertIntoEmptyEditor();

    expect(await harness.insertions[0]?.undo()).toBe(true);
    expect(harness.editor.getLine(0)).toBe("");
    expect(harness.trash).toHaveBeenCalledWith("drawings/new.svg");
    expect(await harness.insertions[0]?.undo()).toBe(false);
  });
});

describe("empty-line insertion failure feedback", () => {
  it("preserves a user-modified embed when undo is stale", async () => {
    const harness = await insertIntoEmptyEditor();
    harness.fakeEditor.lines[2] = "changed";

    expect(await harness.insertions[0]?.undo()).toBe(false);
    expect(harness.editor.getLine(2)).toBe("changed");
    expect(harness.trash).not.toHaveBeenCalled();
    expect(harness.failed).toHaveBeenCalledWith("insertion-undo-note-changed", expect.any(Error));
  });

  it("reports an incomplete undo when moving the file to trash rejects", async () => {
    const harness = await insertIntoEmptyEditor();
    harness.trash.mockRejectedValueOnce(new Error("trash failed"));

    await expect(harness.insertions[0]?.undo()).resolves.toBe(false);

    expect(harness.editor.getLine(0)).toBe("");
    expect(harness.failed).toHaveBeenCalledWith("insertion-undo-file-kept", expect.any(Error));
    await expect(harness.insertions[0]?.undo()).resolves.toBe(false);
  });

  it("reports a failed cleanup without leaving an unhandled insertion rejection", async () => {
    const fake = new FakeEditor(["changed"]);
    const harness = createFailedInsertionHarness({
      editor: fake,
      prepare: async () => ({ content: "<svg />", path: "private/folder/new.svg" }),
      trashError: new Error("trash failed"),
      verifyCreated: async () => true,
    });
    fake.lines[0] = "";
    expect(harness.controller.request(harness.editor, "page.md")).toBe(true);
    fake.lines[0] = "changed";

    await vi.waitFor(() => expect(harness.failed).toHaveBeenCalledOnce());

    expect(harness.failed).toHaveBeenCalledWith("insertion-cleanup-failed", expect.any(Error));
  });
});

describe("Obsidian empty-line insertion composition", () => {
  it("validates an atomic Vault create/read-back before reporting insertion", async () => {
    let path = "";
    const files: MemoryVaultFiles = new Map();
    const ownerWindow = {
      crypto: { getRandomValues: (bytes: Uint8Array) => bytes.fill(9) },
    } as unknown as Window;
    const inserted = vi.fn();
    const failed = vi.fn();
    const app = createInsertionApp(files, ownerWindow, async (filename) => {
      path = `drawings/${filename}`;
      return path;
    });
    const placementFeedback = vi.fn();
    const controller = createObsidianInsertionController(
      app,
      settingsForPlacement({ mode: "obsidian-attachment-folder" }),
      { failed, inserted },
      { show: placementFeedback },
    );
    const editor = new FakeEditor([""]);

    expect(controller.request(editor as unknown as Editor, "notes/page.md")).toBe(true);
    await vi.waitFor(() => expect(inserted).toHaveBeenCalledOnce());

    expect(failed).not.toHaveBeenCalled();
    expect(placementFeedback).not.toHaveBeenCalled();
    expect(path).toMatch(/^drawings\/inkbook-\d{8}-\d{6}-090909\.svg$/u);
    expect(editor.lines[2]).toBe(`!inkbook[[${path}]]`);
    expect(files.get(path)?.text).toContain('data-inkbook-version="1"');
  });

  it.each([
    [
      "attachment folder",
      { mode: "obsidian-attachment-folder" } as const,
      "attachment-folder-unavailable",
    ],
    [
      "custom folder",
      { folder: "missing", mode: "custom-vault-folder" } as const,
      "custom-folder-unavailable",
    ],
  ])("reports the unavailable %s and inserts in the note folder", async (_, placement, message) => {
    const test = createFallbackInsertionHarness(placement);

    await requestAndAwaitInsertion(test);

    expect(test.failed).not.toHaveBeenCalled();
    expect(test.placementFeedback).toHaveBeenCalledWith(message);
    expect(test.getRandomValues).toHaveBeenCalled();
    expect(test.editor.getLine(2)).toMatch(/^!inkbook\[\[notes\/inkbook-.*\.svg\]\]$/u);
  });

  it("continues insertion when the placement feedback port throws", async () => {
    const test = createFallbackInsertionHarness(
      { folder: "missing", mode: "custom-vault-folder" },
      () => {
        throw new Error("feedback unavailable");
      },
    );

    await requestAndAwaitInsertion(test);

    expect(test.failed).not.toHaveBeenCalled();
    expect(test.editor.getLine(2)).toMatch(/^!inkbook\[\[notes\/inkbook-.*\.svg\]\]$/u);
  });

  it("does not report regular note-folder placement", async () => {
    const test = createFallbackInsertionHarness({ mode: "note-folder" });

    await requestAndAwaitInsertion(test);

    expect(test.placementFeedback).not.toHaveBeenCalled();
  });
});

function createFallbackInsertionHarness(
  placement: FilePlacementV1,
  show: (fallback: "attachment-folder-unavailable" | "custom-folder-unavailable") => void = vi.fn(),
) {
  const files: MemoryVaultFiles = new Map();
  const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(9));
  const ownerWindow = { crypto: { getRandomValues } } as unknown as Window;
  const inserted = vi.fn();
  const failed = vi.fn();
  const placementFeedback = vi.fn(show);
  const app = createInsertionApp(files, ownerWindow, async () => {
    throw new Error("attachment folder unavailable");
  });
  const editor = new FakeEditor([""]) as unknown as Editor;
  const controller = createObsidianInsertionController(
    app,
    settingsForPlacement(placement),
    { failed, inserted },
    { show: placementFeedback },
  );
  return { controller, editor, failed, getRandomValues, inserted, placementFeedback };
}

function createMemoryVault(files: MemoryVaultFiles) {
  return {
    create: async (path: string, text: string) => {
      const file = new TestTFile(path, new TextEncoder().encode(text).byteLength);
      files.set(path, { file, text });
      return file;
    },
    getFileByPath: (path: string) => files.get(path)?.file ?? null,
    getFolderByPath: () => null,
    read: async (file: TFile) => files.get(file.path)?.text ?? "",
  };
}

async function requestAndAwaitInsertion(
  test: ReturnType<typeof createFallbackInsertionHarness>,
): Promise<void> {
  expect(test.controller.request(test.editor, "notes/page.md")).toBe(true);
  await vi.waitFor(() => expect(test.inserted).toHaveBeenCalledOnce());
}

function createInsertionApp(
  files: MemoryVaultFiles,
  ownerWindow: Window,
  getAvailablePathForAttachment: (filename: string, sourcePath: string) => Promise<string>,
): App {
  return {
    fileManager: {
      generateMarkdownLink: (file: TFile) => `[[${file.path}]]`,
      getAvailablePathForAttachment,
      trashFile: vi.fn(async () => undefined),
    },
    metadataCache: { getFirstLinkpathDest: () => null, resolvedLinks: {} },
    vault: createMemoryVault(files),
    workspace: activeWorkspace(ownerWindow),
  } as unknown as App;
}

describe("pen-tap insertion", () => {
  it("accepts a bounded regular-tip tap outside an ink widget", async () => {
    const { harness, pen, target } = createPenHarness();

    expect(pen.begin(penSample(), target)).toBe(true);
    expect(pen.complete(penSample({ buttons: 0, clientX: 26, clientY: 48, timeStamp: 600 }))).toBe(
      true,
    );
    await vi.waitFor(() => expect(harness.insertions).toHaveLength(1));
  });

  it.each([
    ["disabled", false, penSample(), false],
    ["mouse", true, penSample({ pointerType: "mouse" }), false],
    ["barrel button", true, penSample({ button: 2, buttons: 2 }), false],
    ["eraser tip", true, penSample({ button: 5, buttons: 32 }), false],
  ])("rejects %s input", (_name, enabled, sample, expected) => {
    const { pen, target } = createPenHarness(enabled);
    expect(pen.begin(sample, target)).toBe(expected);
  });

  it("rejects excess movement, duration, existing widgets, and cancelled pointers", () => {
    const { pen, target } = createPenHarness();

    expect(pen.begin(penSample(), { ...target, insideInkWidget: true })).toBe(false);
    expect(pen.begin(penSample(), target)).toBe(true);
    expect(pen.complete(penSample({ buttons: 0, clientX: 31, timeStamp: 200 }))).toBe(false);
    expect(pen.begin(penSample(), target)).toBe(true);
    expect(pen.complete(penSample({ buttons: 0, timeStamp: 601 }))).toBe(false);
    expect(pen.begin(penSample(), target)).toBe(true);
    pen.cancel(7);
    expect(pen.complete(penSample({ buttons: 0, timeStamp: 200 }))).toBe(false);
  });
});
