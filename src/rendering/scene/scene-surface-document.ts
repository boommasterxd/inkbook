const htmlNamespace = "http://www.w3.org/1999/xhtml";

export function createSceneFrame(ownerDocument: Document): {
  readonly frame: HTMLIFrameElement;
  readonly style: HTMLStyleElement;
} {
  const frame = ownerDocument.createElementNS(htmlNamespace, "iframe") as HTMLIFrameElement;
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("inert", "");
  frame.setAttribute("class", "inkbook-scene-frame");
  frame.tabIndex = -1;
  const style = ownerDocument.createElementNS(htmlNamespace, "style") as HTMLStyleElement;
  style.textContent = `.inkbook-scene-frame {
    border: 0; display: block; width: 100%; height: 100%;
    pointer-events: none; background: transparent;
  }`;
  return { frame, style };
}

export function configureSceneDocument(drawingDocument: Document): HTMLStyleElement {
  const style = drawingDocument.createElementNS(htmlNamespace, "style") as HTMLStyleElement;
  style.textContent = `html, body {
    margin: 0; padding: 0; overflow: hidden; background: transparent;
  }
  body { position: relative; }`;
  drawingDocument.head.append(style);
  return style;
}
