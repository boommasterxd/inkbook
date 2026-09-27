import { TFile, type App } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createObsidianEmbedPasteController } from "../../../../src/obsidian/commands";
import { createBuiltInSettings } from "../../../../src/domain/settings";
import type { FilePlacementV1 } from "../../../../src/domain/settings/types";
import { FILE_SCHEMA_LIMITS } from "../../../../src/domain/schema/public";
import type { InkbookSettingsStore } from "../../../../src/obsidian/settings";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { chooseInkbookAction } from "../../../../src/obsidian/dialogs/action-dialog";
import { CLIPBOARD, FakeEditor, pasteRequest } from "../../../fixtures/obsidian/embed-paste";

const TestTFile = TFile as unknown as new (path: string, size?: number) => TFile;

vi.mock("../../../../src/obsidian/dialogs/action-dialog", () => ({
  chooseInkbookAction: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(chooseInkbookAction).mockReset().mockResolvedValue("duplicate");
});

describe("Obsidian copied-embed dialog", () => {
  it.each(["reference", "duplicate", null] as const)(
    "routes the Obsidian dialog choice %s without using a system prompt",
    async (choice) => {
      const test = createCompositionHarness();
      vi.mocked(chooseInkbookAction).mockResolvedValueOnce(choice);

      const signal = new AbortController().signal;
      const result = await createObsidianEmbedPasteController(
        test.app,
        test.settings,
        { show: vi.fn() },
        signal,
      ).paste(pasteRequest(test.editor));

      const readMotion = vi.mocked(chooseInkbookAction).mock.calls[0]?.[1].readMotion;
      expect(readMotion).toBeTypeOf("function");
      expect(chooseInkbookAction).toHaveBeenCalledWith(test.app, {
        signal,
        readMotion,
        title: "Paste Inkbook embed",
        description: "Choose how this drawing should be inserted.",
        actions: [
          {
            value: "reference",
            label: "Insert reference",
            description: "Edits appear in every embed that uses this file.",
          },
          {
            value: "duplicate",
            label: "Create copy",
            description: "Create an independent SVG copy.",
          },
        ],
      });
      expect(result).toEqual(
        choice === null ? { kind: "cancelled" } : { kind: "inserted", mode: choice },
      );
      expect(test.files.size).toBe(choice === "duplicate" ? 2 : 1);
      if (choice !== "duplicate") {
        expect(test.editor.content).toBe(choice === null ? "" : CLIPBOARD);
      }
    },
  );
});

describe("Obsidian copied-embed composition", () => {
  it("validates through the bounded fallback and reads back a new Vault file before insertion", async () => {
    const test = createCompositionHarness();
    const { app, editor, files, getFileByPath, serialized, settings } = test;
    const placementFeedback = vi.fn();

    const result = await createObsidianEmbedPasteController(app, settings, {
      show: placementFeedback,
    }).paste(pasteRequest(editor));

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
    }).paste(pasteRequest(editor));

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
  }).paste(pasteRequest(test.editor));
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
