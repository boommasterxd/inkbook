import { afterEach, describe, expect, it, vi } from "vitest";

import { EmbedPasteController } from "../../../../src/obsidian/commands/embed-paste";
import { findMarkdownInkbookEmbeds } from "../../../../src/obsidian/embeds/markdown-embed";
import { FakeEditor, guardedRead, pasteRequest } from "../../../fixtures/obsidian/embed-paste";
import { ownedFileRead } from "../../../fixtures/obsidian/owned-file";
import { createHarness } from "./embed-actions-fixture";

afterEach(() => vi.restoreAllMocks());

const original = "drawings/page.svg";
const duplicate = "drawings/recovered.svg";

async function copiedPaste(markdown: string, choice: "duplicate" | "reference") {
  const harness = createHarness({ documentText: markdown });
  const resolve = harness.metadataCache.getFirstLinkpathDest.getMockImplementation()!;
  harness.metadataCache.getFirstLinkpathDest.mockImplementation((path, sourcePath) =>
    path === "page.svg" && sourcePath === "notes/note.md"
      ? harness.target
      : resolve(path, sourcePath),
  );
  const copied = await harness.actions.copyEmbed(original);
  expect(copied.kind).toBe("copied");
  if (copied.kind !== "copied") throw new Error("The embed was not copied.");
  const editor = new FakeEditor();
  const read = vi.fn(async (path: string) => guardedRead(path, `SVG of ${path}`));
  const create = vi.fn(async (path: string, content: string) => guardedRead(path, content));
  const controller = new EmbedPasteController({
    choices: { choose: async () => choice },
    documents: {
      createOwnedAndReadBack: async (path, content, _maximum, onCreated) =>
        ownedFileRead(path, await create(path, content), onCreated),
      readWithMetadataGuard: read,
    },
    links: harness.links,
    placement: { preparePath: async () => duplicate },
    trash: { trashCreated: vi.fn(async () => undefined) },
    validation: { validate: async () => true },
  });
  const outcome = await controller.paste(
    pasteRequest(editor, {
      clipboardText: copied.markdown,
      sourcePath: "notes/deep/destination.md",
    }),
  );
  return { copied, create, editor, harness, outcome, read };
}

describe("portable copied embed identity", () => {
  it.each([
    ["![[../drawings/page.svg|Drawing|00400]]", "reference", "Drawing", 400],
    ["![Drawing|00400](../drawings/page.svg)", "duplicate", "Drawing", 400],
    ["![[page.svg|Drawing|00400]]", "duplicate", "Drawing", 400],
  ] as const)(
    "keeps the original SVG across note folders for %s",
    async (markdown, choice, description, width) => {
      const test = await copiedPaste(markdown, choice);

      expect(test.outcome).toEqual({ kind: "inserted", mode: choice });
      expect(test.read).toHaveBeenCalledExactlyOnceWith(original, expect.any(Number));
      expect(test.harness.editor.value()).toBe(markdown);
      expect(test.harness.process).not.toHaveBeenCalled();
      const [copied] = findMarkdownInkbookEmbeds(test.copied.markdown);
      const [inserted] = findMarkdownInkbookEmbeds(test.editor.content);
      expect(copied?.linkpath).toBe(original);
      expect(inserted?.linkpath).toBe(choice === "reference" ? original : duplicate);
      expect(inserted?.description).toBe(description);
      expect(inserted?.width).toBe(width);
      if (choice === "duplicate")
        expect(test.create).toHaveBeenCalledExactlyOnceWith(duplicate, `SVG of ${original}`);
      else expect(test.create).not.toHaveBeenCalled();
    },
  );

  it("does not report success when the system clipboard write fails", async () => {
    const harness = createHarness({ documentText: "![[../drawings/page.svg]]" });
    const error = new Error("Clipboard permission denied");
    harness.writeText.mockRejectedValueOnce(error);

    await expect(harness.actions.copyEmbed(original)).resolves.toEqual({ kind: "failed", error });
    expect(harness.editor.value()).toBe("![[../drawings/page.svg]]");
  });
});
