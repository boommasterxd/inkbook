/** Creates the public iframe ownership link that HappyDOM leaves unset on Window.frameElement. */
export function appendOwnedIframe(ownerDocument = document) {
  const frame = ownerDocument.createElement("iframe");
  ownerDocument.body.append(frame);
  const child = frame.contentDocument;
  if (child === null || child.defaultView === null) throw new Error("Missing iframe document.");
  if (child.defaultView.frameElement !== frame) {
    Object.defineProperty(child.defaultView, "frameElement", { configurable: true, value: frame });
  }
  return { frame, document: child };
}
