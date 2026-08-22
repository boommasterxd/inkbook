import { describe, expect, it } from "vitest";

import type { PresentationAttachment } from "../../../../src/obsidian/embeds/presentation-port";
import { ownsMarkdownEditorChange } from "../../../../src/obsidian/embeds/workspace-runtime-editor";

describe("workspace Markdown history ownership", () => {
  it("accepts only the attachment source in its owning pane", () => {
    const root = {} as HTMLElement;
    const owningPane = { contains: (candidate: Node) => candidate === root } as HTMLElement;
    const otherPane = { contains: () => false } as unknown as HTMLElement;
    const attachment = {
      attachmentGeneration: 1,
      attachmentId: "attachment",
      documentId: "drawings/ink.svg",
      embedReference: {
        documentId: "drawings/ink.svg",
        from: 10,
        kind: "live-preview",
        sourcePath: "notes/page.md",
        to: 30,
      },
      root,
      scrollOwner: () => null,
    } satisfies PresentationAttachment;

    expect(ownsMarkdownEditorChange(attachment, "notes/page.md", owningPane)).toBe(true);
    expect(ownsMarkdownEditorChange(attachment, "notes/other.md", owningPane)).toBe(false);
    expect(ownsMarkdownEditorChange(attachment, "notes/page.md", otherPane)).toBe(false);
  });
});
