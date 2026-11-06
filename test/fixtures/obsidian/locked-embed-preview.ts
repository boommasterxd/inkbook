/** Creates an independently owned locked-preview surface for menu integration tests. */
export function createLockedEmbedPreview(ownerDocument: Document) {
  const root = ownerDocument.body.createDiv({ cls: "inkbook-root" });
  root.dataset.inkbookState = "locked";
  root.dataset.inkbookMotion = "reduced";
  const preview = root.createEl("button", { text: "Edit handwriting" });
  return { root, preview };
}
