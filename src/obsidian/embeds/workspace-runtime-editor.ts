import type { PresentationAttachment } from "./presentation-port";

export function ownsMarkdownEditorChange(
  attachment: PresentationAttachment,
  sourcePath: string,
  pane: HTMLElement,
): boolean {
  return (
    attachment.embedReference.sourcePath === sourcePath &&
    (pane === attachment.root || pane.contains(attachment.root))
  );
}
