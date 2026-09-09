import { describe, expect, it, vi } from "vitest";

import type { PresentationEmbedReference } from "../../../../src/obsidian/embeds/presentation-port";
import { createHarness } from "./embed-actions-fixture";

const EMBED = "!inkbook[[drawings/page.svg]]";

const cases = [
  {
    name: "canonical spacing",
    prefix: "Before\n\n\n",
    suffix: "\n\nAfter",
    expected: "Before\n\nAfter",
  },
  {
    name: "extra blank lines",
    prefix: "Before\n\n\n\n",
    suffix: "\n\n\nAfter",
    expected: "Before\n\n\n\nAfter",
  },
  { name: "adjacent content", prefix: "Before\n", suffix: "\nAfter", expected: "Before\nAfter" },
  { name: "note start", prefix: "", suffix: "\n\nAfter", expected: "After" },
  { name: "note end", prefix: "Before\n\n", suffix: "", expected: "Before" },
  { name: "only embed", prefix: "", suffix: "", expected: "" },
  { name: "blank note", prefix: "\n\n", suffix: "\n\n", expected: "\n" },
  { name: "one leading blank", prefix: "\n", suffix: "\nAfter", expected: "After" },
  {
    name: "whitespace and CRLF",
    prefix: "Before\r\n \t\r\n  ",
    suffix: " \r\n\t\r\nAfter",
    expected: "Before\r\nAfter",
  },
  { name: "CRLF at note end", prefix: "Before\r\n\r\n", suffix: "", expected: "Before" },
] as const;

describe.each(["live-preview", "reading-view"] as const)("%s embed removal spacing", (kind) => {
  it.each(cases)(
    "removes one adjacent blank per side: $name",
    async ({ prefix, suffix, expected }) => {
      const documentText = `${prefix}${EMBED}${suffix}`;
      const harness = createHarness({ documentText, references: 2 });
      const reference: PresentationEmbedReference =
        kind === "live-preview"
          ? {
              documentId: "drawings/page.svg",
              from: prefix.length,
              kind,
              sourcePath: "notes/note.md",
              to: prefix.length + EMBED.length,
            }
          : {
              documentId: "drawings/page.svg",
              kind,
              markdown: EMBED,
              section: {
                lineEnd: documentText.split("\n").length - 1,
                lineStart: 0,
                text: documentText,
              },
              sectionFrom: prefix.length,
              sectionTo: prefix.length + EMBED.length,
              sourcePath: "notes/note.md",
            };

      await expect(harness.actions.deleteEmbed(reference)).resolves.toEqual({
        fileDeleted: false,
        kind: "deleted",
      });

      expect(kind === "live-preview" ? harness.editor.value() : harness.vaultText()).toBe(expected);
      expect(harness.trashFile).not.toHaveBeenCalled();
    },
  );

  it("preserves newer surrounding text when the note changes before deletion", async () => {
    const documentText = `Before\n\n${EMBED}\n\nAfter`;
    const harness = createHarness({ documentText, references: 2 });
    const newerText = documentText.replace("Before", "Edited");
    const reference: PresentationEmbedReference =
      kind === "live-preview"
        ? {
            documentId: "drawings/page.svg",
            from: 8,
            kind,
            sourcePath: "notes/note.md",
            to: 8 + EMBED.length,
          }
        : {
            documentId: "drawings/page.svg",
            kind,
            markdown: EMBED,
            section: { lineEnd: 0, lineStart: 0, text: EMBED },
            sectionFrom: 0,
            sectionTo: EMBED.length,
            sourcePath: "notes/note.md",
          };
    if (kind === "live-preview") {
      vi.spyOn(harness.editor, "getValue")
        .mockReturnValueOnce(documentText)
        .mockReturnValueOnce(documentText)
        .mockImplementation(() => {
          harness.editor.replaceRange("Edited", { line: 0, ch: 0 }, { line: 0, ch: 6 });
          return harness.editor.value();
        });
    } else {
      harness.setBeforeProcess(() => harness.setVaultText(newerText));
    }

    await expect(harness.actions.deleteEmbed(reference)).resolves.toEqual({
      kind: "unavailable",
      reason: "editor-changed",
    });
    expect(kind === "live-preview" ? harness.editor.value() : harness.vaultText()).toBe(newerText);
    expect(harness.trashFile).not.toHaveBeenCalled();
  });
});
