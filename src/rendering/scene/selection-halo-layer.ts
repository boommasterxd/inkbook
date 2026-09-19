import { SVG_NAMESPACE } from "./constants";
import type { SelectionHaloContext } from "./selection-halo";
import type { MutableSceneInstrumentation } from "./types";

/** One viewport-bounded filter erodes the union of selected ink, never each fragment. */
export class SelectionHaloLayer {
  public readonly node: SVGGElement;
  readonly #filter: SVGFilterElement;
  readonly #erosion: SVGFEMorphologyElement;
  readonly #composite: SVGFECompositeElement;
  readonly #attributes = new Map<SVGElement, Map<string, string>>();
  readonly #instrumentation: MutableSceneInstrumentation;
  #bytes = 4 * 128;

  public constructor(
    parent: SVGGElement,
    instrumentation: MutableSceneInstrumentation,
    reference: SVGElement | null,
  ) {
    this.#instrumentation = instrumentation;
    const document = parent.ownerDocument;
    this.node = document.createElementNS(SVG_NAMESPACE, "g");
    this.#filter = document.createElementNS(SVG_NAMESPACE, "filter");
    this.#erosion = document.createElementNS(SVG_NAMESPACE, "feMorphology");
    this.#composite = document.createElementNS(SVG_NAMESPACE, "feComposite");
    for (const node of [this.node, this.#filter, this.#erosion, this.#composite]) {
      this.#attributes.set(node, new Map());
    }
    const id = `inkbook-inner-selection-${String(++nextLayerId)}`;
    this.write(this.#filter, "id", id);
    this.write(this.#filter, "filterUnits", "userSpaceOnUse");
    this.write(this.#filter, "primitiveUnits", "userSpaceOnUse");
    this.write(this.#filter, "color-interpolation-filters", "sRGB");
    this.write(this.#erosion, "in", "SourceAlpha");
    this.write(this.#erosion, "operator", "erode");
    this.write(this.#erosion, "result", "interior");
    this.write(this.#composite, "in", "SourceGraphic");
    this.write(this.#composite, "in2", "interior");
    this.write(this.#composite, "operator", "out");
    this.write(this.node, "class", "inkbook-selection-halo");
    this.write(this.node, "filter", `url(#${id})`);
    this.#filter.append(this.#erosion, this.#composite);
    parent.insertBefore(this.#filter, reference);
    parent.insertBefore(this.node, reference);
    instrumentation.selectionTraceNodesCreated += 4;
  }

  public setContext({ camera, viewport }: SelectionHaloContext): void {
    this.write(this.#erosion, "radius", String(1.5 / camera.zoom));
    const padding = 3 / camera.zoom;
    const region =
      viewport === undefined
        ? { x: 0, y: 0, width: 0, height: 0 }
        : {
            x: viewport.left / camera.zoom - camera.x - padding,
            y: viewport.top / camera.zoom - padding,
            width: viewport.width / camera.zoom + padding * 2,
            height: viewport.height / camera.zoom + padding * 2,
          };
    for (const [name, value] of Object.entries(region))
      this.write(this.#filter, name, String(value));
  }

  public memoryUsage(): number {
    return this.#bytes;
  }

  public release(): void {
    this.#filter.remove();
    this.node.remove();
    this.#erosion.remove();
    this.#composite.remove();
    this.#attributes.clear();
    this.#bytes = 0;
    this.#instrumentation.selectionTraceNodesRemoved += 4;
  }

  private write(node: SVGElement, name: string, value: string): void {
    const attributes = this.#attributes.get(node)!;
    const previous = attributes.get(name) ?? "";
    if (previous === value) return;
    node.setAttribute(name, value);
    attributes.set(name, value);
    this.#bytes += (value.length - previous.length) * 2;
    this.#instrumentation.attributeWrites += 1;
    this.#instrumentation.selectionTraceAttributeWrites += 1;
  }
}

let nextLayerId = 0;
