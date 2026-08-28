import { TFile, type App, type Editor, type EditorPosition } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import {
  CREATE_ANOTHER_REFERENCE,
  EmbedPasteController,
  MAKE_DUPLICATE,
  OwnerWindowEmbedPasteChoice,
  createEmbedPasteExtensionBoundary,
  isCopiedEmbedPaste,
  createObsidianEmbedPasteController,
} from "../../../../src/obsidian/commands";
import { createBuiltInSettings } from "../../../../src/domain/settings";
import type { FilePlacementV1 } from "../../../../src/domain/settings/types";
import { FILE_SCHEMA_LIMITS } from "../../../../src/domain/schema/public";
import type { InkbookSettingsStore } from "../../../../src/obsidian/settings";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";

class FakeEditor {
  content: string;
  from: EditorPosition;
  to: EditorPosition;
  readonly replacements: string[] = [];

  constructor(content = "", from = 0, to = from) {
    this.content = content;
    this.from = { ch: from, line: 0 };
    this.to = { ch: to, line: 0 };
  }

  getCursor(side?: "anchor" | "from" | "head" | "to"): EditorPosition {
    return side === "to" || side === "head" ? this.to : this.from;
  }

  getRange(from: EditorPosition, to: EditorPosition): string {
    return this.content.slice(from.ch, to.ch);
  }

  getValue(): string {
    return this.content;
  }

  replaceRange(replacement: string, from: EditorPosition, to = from): void {
    this.replacements.push(replacement);
    this.content = this.content.slice(0, from.ch) + replacement + this.content.slice(to.ch);
    const cursor = from.ch + replacement.length;
    this.from = { ch: cursor, line: 0 };
    this.to = this.from;
  }
}

const CLIPBOARD = "!inkbook[[drawings/source.svg]]";
const SOURCE = '<svg data-inkbook-version="1"></svg>';
const TestTFile = TFile as unknown as new (path: string, size?: number) => TFile;

function request(editor: FakeEditor, overrides: Record<string, unknown> = {}) {
  return {
    clipboardText: CLIPBOARD,
    editor: editor as unknown as Editor,
    insideInkWidget: false,
    sourcePath: "notes/page.md",
    ...overrides,
  };
}

function harness(choice: "duplicate" | "reference" | null) {
  const events: string[] = [];
  const create = vi.fn(async (path: string, content: string) => {
    events.push(`create:${path}:${content}`);
    events.push(`read:${path}`);
    return guardedRead(path, content);
  });
  const read = vi.fn(async (path: string) => {
    events.push(`read:${path}`);
    return guardedRead(path, SOURCE);
  });
  const validate = vi.fn(async (content: string) => {
    events.push(`validate:${content}`);
    return true;
  });
  const choose = vi.fn(async () => {
    events.push("choose");
    return choice;
  });
  const trash = vi.fn(async (path: string) => {
    events.push(`trash:${path}`);
  });
  const controller = new EmbedPasteController({
    choices: { choose },
    documents: { createAndReadBack: create, readWithMetadataGuard: read },
    links: {
      generateEmbed: (path) => {
        events.push(`link:${path}`);
        return `!inkbook[[${path}]]`;
      },
      resolveLinkTarget: (linkpath) =>
        linkpath === "drawings/source.svg" ? { path: "drawings/source.svg" } : null,
    },
    placement: {
      preparePath: async () => {
        events.push("place");
        return "drawings/duplicate.svg";
      },
    },
    trash: { trash },
    validation: { validate },
  });
  return { choose, controller, create, events, read, trash, validate };
}

describe("copied Inkbook embed paste", () => {
  it("recognizes only one complete SVG embed outside an Inkbook widget", () => {
    expect(isCopiedEmbedPaste(CLIPBOARD, false)).toBe(true);
    expect(isCopiedEmbedPaste(`${CLIPBOARD}\n`, false)).toBe(false);
    expect(isCopiedEmbedPaste(`${CLIPBOARD}${CLIPBOARD}`, false)).toBe(false);
    expect(isCopiedEmbedPaste("![[drawing.png]]", false)).toBe(false);
    expect(isCopiedEmbedPaste(CLIPBOARD, true)).toBe(false);
  });

  it("maps only the two exact owner-window prompt choices and treats all else as cancel", async () => {
    expect(CREATE_ANOTHER_REFERENCE).toBe("Reference existing file");
    const prompt = vi
      .fn()
      .mockReturnValueOnce(CREATE_ANOTHER_REFERENCE)
      .mockReturnValueOnce(MAKE_DUPLICATE)
      .mockReturnValueOnce("reference")
      .mockReturnValueOnce(null);
    const choices = new OwnerWindowEmbedPasteChoice({ prompt } as unknown as Window);

    await expect(choices.choose()).resolves.toBe("reference");
    await expect(choices.choose()).resolves.toBe("duplicate");
    await expect(choices.choose()).resolves.toBeNull();
    await expect(choices.choose()).resolves.toBeNull();
    expect(prompt).toHaveBeenCalledWith(
      `Paste Inkbook embed. Enter "${CREATE_ANOTHER_REFERENCE}" or "${MAKE_DUPLICATE}".`,
      CREATE_ANOTHER_REFERENCE,
    );
  });

  it("validates the resolved source before inserting another reference", async () => {
    const editor = new FakeEditor("selected", 0, 8);
    const test = harness("reference");

    await expect(test.controller.paste(request(editor))).resolves.toEqual({
      kind: "inserted",
      mode: "reference",
    });
    expect(editor.content).toBe(CLIPBOARD);
    expect(test.events).toEqual(["read:drawings/source.svg", `validate:${SOURCE}`, "choose"]);
    expect(test.create).not.toHaveBeenCalled();
  });

  it("inserts the original Markdown without prompting when the SVG is not valid Inkbook data", async () => {
    const editor = new FakeEditor();
    const test = harness("duplicate");
    test.validate.mockResolvedValue(false);

    await expect(test.controller.paste(request(editor))).resolves.toEqual({
      kind: "inserted",
      mode: "original",
    });
    expect(editor.content).toBe(CLIPBOARD);
    expect(test.choose).not.toHaveBeenCalled();
    expect(test.create).not.toHaveBeenCalled();
  });

  it("cancels without changing the editor or creating a file", async () => {
    const editor = new FakeEditor("selected", 0, 8);
    const test = harness(null);

    await expect(test.controller.paste(request(editor))).resolves.toEqual({ kind: "cancelled" });
    expect(editor.content).toBe("selected");
    expect(test.create).not.toHaveBeenCalled();
    expect(test.trash).not.toHaveBeenCalled();
  });
});

describe("copied Inkbook embed duplication", () => {
  it("creates, reads back, and validates the duplicate before inserting its generated link", async () => {
    const editor = new FakeEditor();
    const test = harness("duplicate");
    const originalReplace = editor.replaceRange.bind(editor);
    editor.replaceRange = (replacement, from, to = from) => {
      test.events.push(`replace:${replacement}`);
      originalReplace(replacement, from, to);
    };

    await expect(test.controller.paste(request(editor))).resolves.toEqual({
      kind: "inserted",
      mode: "duplicate",
    });
    expect(editor.content).toBe("!inkbook[[drawings/duplicate.svg]]");
    expect(test.events).toEqual([
      "read:drawings/source.svg",
      `validate:${SOURCE}`,
      "choose",
      "place",
      `create:drawings/duplicate.svg:${SOURCE}`,
      "read:drawings/duplicate.svg",
      `validate:${SOURCE}`,
      "link:drawings/duplicate.svg",
      "replace:!inkbook[[drawings/duplicate.svg]]",
    ]);
  });

  it("moves a completed duplicate to recoverable trash when the editor became stale", async () => {
    const editor = new FakeEditor();
    const test = harness("duplicate");
    test.create.mockImplementation(async (path, content) => {
      editor.content = "user edit";
      return guardedRead(path, content);
    });

    await expect(test.controller.paste(request(editor))).resolves.toEqual({
      cleanup: "trashed",
      kind: "stale",
    });
    expect(editor.content).toBe("user edit");
    expect(test.trash).toHaveBeenCalledWith("drawings/duplicate.svg");
  });

  it("does not trash an unrelated collision when Vault.create fails", async () => {
    const editor = new FakeEditor();
    const test = harness("duplicate");
    const collision = new Error("collision");
    test.create.mockRejectedValue(collision);

    await expect(test.controller.paste(request(editor))).resolves.toEqual({
      error: collision,
      kind: "failed",
    });
    expect(test.trash).not.toHaveBeenCalled();
    expect(editor.content).toBe("");
  });

  it("defines a synchronous extension boundary that prevents only recognized paste events", async () => {
    const editor = new FakeEditor();
    const test = harness("reference");
    const report = vi.fn();
    const boundary = createEmbedPasteExtensionBoundary(test.controller, report);

    expect(boundary.handleClipboardPaste(request(editor))).toBe(true);
    expect(boundary.handleClipboardPaste(request(editor, { clipboardText: "ordinary text" }))).toBe(
      false,
    );
    await vi.waitFor(() =>
      expect(report).toHaveBeenCalledWith({ kind: "inserted", mode: "reference" }),
    );
  });
});

describe("atomic copied-embed duplicate read-back", () => {
  it("trashes a created file that fails exact read-back validation", async () => {
    const editor = new FakeEditor();
    const test = harness("duplicate");
    test.create.mockResolvedValueOnce(guardedRead("drawings/duplicate.svg", `${SOURCE}changed`));

    const outcome = await test.controller.paste(request(editor));
    expect(outcome.kind).toBe("failed");
    expect(test.trash).toHaveBeenCalledWith("drawings/duplicate.svg");
    expect(editor.content).toBe("");
  });

  it("rejects a replacement identity returned by atomic create-and-read-back", async () => {
    const editor = new FakeEditor();
    const test = harness("duplicate");
    test.create.mockResolvedValueOnce(guardedRead("drawings/replaced.svg", SOURCE));

    await expect(test.controller.paste(request(editor))).resolves.toMatchObject({ kind: "failed" });
    expect(test.trash).toHaveBeenCalledWith("drawings/duplicate.svg");
    expect(editor.content).toBe("");
  });

  it("fails closed when atomic read-back rejects raced oversized content", async () => {
    const editor = new FakeEditor();
    const test = harness("duplicate");
    test.create.mockRejectedValueOnce(new Error("file-too-large"));

    await expect(test.controller.paste(request(editor))).resolves.toMatchObject({ kind: "failed" });
    expect(test.create).toHaveBeenCalledWith(
      "drawings/duplicate.svg",
      SOURCE,
      FILE_SCHEMA_LIMITS.totalInputBytes,
    );
    expect(test.trash).not.toHaveBeenCalled();
    expect(editor.content).toBe("");
  });
});

describe("Obsidian copied-embed composition", () => {
  it("validates through the bounded fallback and reads back a new Vault file before insertion", async () => {
    const test = createCompositionHarness();
    const { app, editor, files, getFileByPath, serialized, settings } = test;
    const placementFeedback = vi.fn();

    const result = await createObsidianEmbedPasteController(app, settings, {
      show: placementFeedback,
    }).paste(request(editor));

    expect(result).toEqual({ kind: "inserted", mode: "duplicate" });
    expect(placementFeedback).not.toHaveBeenCalled();
    expect(test.duplicatePath).toMatch(/^drawings\/inkbook-\d{8}-\d{6}-010101\.svg$/u);
    expect(editor.content).toBe(`!inkbook[[${test.duplicatePath}]]`);
    expect(files.get(test.duplicatePath)?.text).toBe(serialized.value.svg);
    expect(
      getFileByPath.mock.calls.filter(([path]) => path === "drawings/source.svg").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      getFileByPath.mock.calls.filter(([path]) => path === test.duplicatePath).length,
    ).toBeGreaterThanOrEqual(2);
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
  ])(
    "reports the unavailable %s and duplicates in the note folder",
    async (_, placement, message) => {
      const test = createCompositionHarness({ attachmentUnavailable: true, placement });
      const { placementFeedback, result } = await runCompositionPaste(test);

      expect(result).toEqual({ kind: "inserted", mode: "duplicate" });
      expect(placementFeedback).toHaveBeenCalledWith(message);
      expect(test.getRandomValues).toHaveBeenCalled();
      expect(test.editor.content).toMatch(/^!inkbook\[\[notes\/inkbook-.*\.svg\]\]$/u);
    },
  );

  it("continues duplication when the placement feedback port throws", async () => {
    const test = createCompositionHarness({
      attachmentUnavailable: true,
      placement: { mode: "obsidian-attachment-folder" },
    });

    const { result } = await runCompositionPaste(test, () => {
      throw new Error("feedback unavailable");
    });

    expect(result).toEqual({ kind: "inserted", mode: "duplicate" });
    expect(test.editor.content).toMatch(/^!inkbook\[\[notes\/inkbook-.*\.svg\]\]$/u);
  });

  it("does not report regular note-folder placement", async () => {
    const test = createCompositionHarness({ placement: { mode: "note-folder" } });
    const { placementFeedback, result } = await runCompositionPaste(test);

    expect(result).toEqual({ kind: "inserted", mode: "duplicate" });
    expect(placementFeedback).not.toHaveBeenCalled();
  });
});

describe("Obsidian copied-embed size boundaries", () => {
  it("rejects content that grows after the Vault size preflight", async () => {
    const oversized = "x".repeat(FILE_SCHEMA_LIMITS.totalInputBytes + 1);
    const { app, editor, settings } = createCompositionHarness({
      sourceSize: 1,
      readSource: () => oversized,
    });
    const result = await createObsidianEmbedPasteController(app, settings, {
      show: vi.fn(),
    }).paste(request(editor));

    expect(result).toEqual({ kind: "inserted", mode: "original" });
    expect(editor.content).toBe(CLIPBOARD);
  });
});

async function runCompositionPaste(
  test: ReturnType<typeof createCompositionHarness>,
  placementFeedback: (
    fallback: "attachment-folder-unavailable" | "custom-folder-unavailable",
  ) => void = vi.fn(),
) {
  const result = await createObsidianEmbedPasteController(test.app, test.settings, {
    show: placementFeedback,
  }).paste(request(test.editor));
  return { placementFeedback, result };
}

function createCompositionHarness(
  options: {
    readonly attachmentUnavailable?: boolean;
    readonly placement?: FilePlacementV1;
    readonly readSource?: (file: TFile) => string;
    readonly sourceSize?: number;
  } = {},
) {
  const serialized = serializeInkbookDocument({
    elements: [],
    format: "inkbook",
    page: {
      activeBufferLines: 3,
      background: { type: "none" },
      innerWidth: 2000,
      lockedBufferLines: 1,
      margin: 24.3,
    },
    revision: 0,
    version: 1,
  });
  if (!serialized.ok) throw new Error(serialized.error.message);
  const files = new Map<string, { file: TFile; text: string }>();
  const source = new TestTFile(
    "drawings/source.svg",
    options.sourceSize ?? serialized.value.svg.length,
  );
  files.set(source.path, { file: source, text: serialized.value.svg });
  let duplicatePath = "";
  const getFileByPath = vi.fn((path: string) => files.get(path)?.file ?? null);
  const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(1));
  const ownerWindow = {
    crypto: {
      getRandomValues,
      randomUUID: () => "00000000-0000-4000-8000-000000000099",
    },
    prompt: () => MAKE_DUPLICATE,
  } as unknown as Window;
  const app = {
    fileManager: {
      generateMarkdownLink: (file: TFile) => `[[${file.path}]]`,
      getAvailablePathForAttachment: async (filename: string) => {
        if (options.attachmentUnavailable === true) {
          throw new Error("attachment folder unavailable");
        }
        duplicatePath = `drawings/${filename}`;
        return duplicatePath;
      },
      trashFile: vi.fn(async () => undefined),
    },
    metadataCache: {
      getFirstLinkpathDest: () => source,
      resolvedLinks: {},
    },
    vault: {
      create: async (path: string, text: string) => {
        const file = new TestTFile(path, text.length);
        files.set(path, { file, text });
        return file;
      },
      getFileByPath,
      getFolderByPath: () => null,
      read: async (file: TFile) => options.readSource?.(file) ?? files.get(file.path)?.text ?? "",
    },
    workspace: {
      getActiveViewOfType: () => ({
        containerEl: { ownerDocument: { defaultView: ownerWindow } },
      }),
    },
  } as unknown as App;
  const settings = {
    getVaultSettings: () => ({
      ...createBuiltInSettings(),
      filePlacement: options.placement ?? { mode: "obsidian-attachment-folder" as const },
    }),
  } as InkbookSettingsStore;
  return {
    app,
    get duplicatePath() {
      return duplicatePath;
    },
    editor: new FakeEditor(),
    files,
    getFileByPath,
    getRandomValues,
    serialized,
    settings,
  };
}

function guardedRead(path: string, content: string) {
  return {
    content,
    identity: { ctime: 0, mtime: 0, path, size: content.length },
    materialization: "host-full-read-not-bounded" as const,
    stabilityEvidence: "object-identity-and-stat-unchanged" as const,
  };
}
