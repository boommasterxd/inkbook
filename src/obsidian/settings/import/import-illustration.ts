/** Shared decorative SVG semantics for the scan and completion illustrations. */
export function createImportIllustration(container: HTMLElement, className: string): SVGSVGElement {
  const graphic = container.createSvg("svg");
  graphic.setAttribute("viewBox", "0 0 96 96");
  graphic.setAttribute("aria-hidden", "true");
  graphic.setAttribute("focusable", "false");
  graphic.classList.add(className);
  return graphic;
}
