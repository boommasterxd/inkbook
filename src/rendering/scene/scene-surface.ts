/** Keeps host ancestor selector invalidations outside the retained SVG tree. */
export class SceneSurface {
  public readonly host: HTMLDivElement;
  readonly #svg: SVGSVGElement;

  public constructor(svg: SVGSVGElement) {
    this.#svg = svg;
    this.host = svg.ownerDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    this.host.setAttribute("class", "inkbook-scene");
    this.host.setAttribute("aria-hidden", "true");
    this.host.attachShadow({ mode: "open" }).append(svg);
  }

  public release(): void {
    this.#svg.remove();
    this.host.remove();
  }
}
