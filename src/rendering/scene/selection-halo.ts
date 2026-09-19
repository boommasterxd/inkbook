import type { SvgPathPart } from "../../domain/geometry/element-path";
import type { InkElementV1 } from "../../domain/schema/public";
import { SVG_NAMESPACE } from "./constants";
import { pathPresentation } from "./element-presentation";
import type { MountedSceneElement } from "./mounted-element";
import type { MutableSceneInstrumentation, SceneCamera, SceneViewport } from "./types";

interface HaloSurface {
  readonly definitions: SVGDefsElement;
  readonly paint: SVGGElement;
  readonly reference: SVGUseElement;
}

export interface SelectionHaloContext {
  readonly camera: SceneCamera;
  readonly viewport: SceneViewport | undefined;
}

let nextHaloId = 0;

/** Retained opaque ink feeds the shared union filter; center traces remain independent. */
export class SelectionHalo {
  public readonly node: SVGGElement;
  #surface: HaloSurface | undefined;
  readonly #parts: SVGPathElement[] = [];
  readonly #attributes = new Map<SVGElement, Map<string, string>>();
  readonly #ownerDocument: Document;
  readonly #instrumentation: MutableSceneInstrumentation;
  #center: SVGPathElement | undefined;
  #element: InkElementV1;
  #geometry: readonly SvgPathPart[] = [];
  #context: SelectionHaloContext;
  #strokeScale: number | null = null;
  #bytes = 0;

  public constructor(
    parent: SVGGElement,
    entry: MountedSceneElement,
    context: SelectionHaloContext,
    instrumentation: MutableSceneInstrumentation,
  ) {
    this.#ownerDocument = parent.ownerDocument;
    this.#instrumentation = instrumentation;
    this.#context = context;
    this.#element = entry.displayedElement;
    this.node = this.create("g");
    this.write(this.node, "data-selection-element-id", entry.id);
    parent.append(this.node);
  }

  public memoryUsage(): number {
    return this.#bytes;
  }

  public update(
    entry: MountedSceneElement,
    element: InkElementV1,
    parts: readonly SvgPathPart[],
    haloLayer: SVGGElement | null,
  ): void {
    this.#element = element;
    this.#geometry = parts;
    this.setHaloLayer(haloLayer);
    this.syncParts();
    if (element.kind === "line" || element.kind === "arrow") this.syncCenter();
    this.transform(entry.appliedPreviewTransform, entry.previewStrokeWidthScale);
  }

  public setContext(context: SelectionHaloContext): void {
    this.#context = context;
    this.paint();
  }

  public transform(transform: string | null, strokeScale: number | null): void {
    this.#strokeScale = strokeScale;
    for (const node of [this.#surface?.paint, this.#center]) {
      if (node !== undefined) this.write(node, "transform", transform);
    }
    this.paint();
  }

  public release(): void {
    this.node.remove();
    this.#surface?.reference.remove();
    this.#instrumentation.selectionTraceNodesRemoved += this.#attributes.size;
    this.#attributes.clear();
    this.#bytes = 0;
  }

  private setHaloLayer(layer: SVGGElement | null): void {
    if (layer !== null && this.#surface === undefined) this.#surface = this.createSurface(layer);
    else if (layer === null && this.#surface !== undefined) {
      for (const part of this.#parts) this.remove(part);
      this.#parts.length = 0;
      const { definitions, paint, reference } = this.#surface;
      for (const node of [definitions, paint, reference]) this.remove(node);
      this.#surface = undefined;
    }
  }

  private createSurface(layer: SVGGElement): HaloSurface {
    const definitions = this.create("defs");
    const paint = this.create("g");
    const id = `inkbook-selection-source-${String(++nextHaloId)}`;
    this.write(paint, "id", id);
    this.write(paint, "class", "inkbook-selection-halo-source");
    definitions.append(paint);
    const reference = this.create("use");
    this.write(reference, "href", `#${id}`);
    layer.append(reference);
    this.node.insertBefore(definitions, this.#center ?? null);
    return { definitions, paint, reference };
  }

  private syncParts(): void {
    const surface = this.#surface;
    if (surface === undefined) return;
    while (this.#parts.length > this.#geometry.length) this.remove(this.#parts.pop()!);
    for (const [index, geometry] of this.#geometry.entries()) {
      let part = this.#parts[index];
      if (part === undefined) {
        part = this.create("path");
        this.#parts.push(part);
        surface.paint.append(part);
        this.write(part, "class", "inkbook-selection-halo-path");
      }
      this.write(part, "d", geometry.d);
    }
  }

  private syncCenter(): void {
    if (this.#center === undefined) {
      this.#center = this.create("path");
      this.write(this.#center, "class", "inkbook-selection-center-trace");
      this.write(this.#center, "vector-effect", "non-scaling-stroke");
      this.node.append(this.#center);
    }
    const d =
      this.#geometry.length === 1
        ? this.#geometry[0]!.d
        : this.#geometry.map(({ d }) => d).join("");
    this.write(this.#center, "d", d);
  }

  private paint(): void {
    const zoom = this.#context.camera.zoom;
    for (const [index, node] of this.#parts.entries()) {
      const geometry = this.#geometry[index]!;
      const presentation = pathPresentation(this.#element, geometry);
      const width = Number(presentation["stroke-width"] ?? 0);
      const dash = presentation["stroke-dasharray"];
      const scale = this.#strokeScale ?? zoom;
      this.write(node, "fill", geometry.paint === "fill" ? "currentColor" : "none");
      this.write(node, "stroke", width > 0 ? "currentColor" : "none");
      this.write(node, "stroke-width", String(width * scale));
      this.write(node, "vector-effect", "non-scaling-stroke");
      this.write(node, "stroke-linecap", presentation["stroke-linecap"] ?? "round");
      this.write(node, "stroke-linejoin", "round");
      this.write(node, "fill-rule", "nonzero");
      this.write(
        node,
        "stroke-dasharray",
        dash === null
          ? null
          : dash
              .split(" ")
              .map((value) => String(Number(value) * scale))
              .join(" "),
      );
    }
  }

  private create<K extends keyof SVGElementTagNameMap>(kind: K): SVGElementTagNameMap[K] {
    const node = this.#ownerDocument.createElementNS(SVG_NAMESPACE, kind);
    this.#attributes.set(node, new Map());
    this.#bytes += 128;
    this.#instrumentation.selectionTraceNodesCreated += 1;
    return node;
  }

  private remove(node: SVGElement): void {
    node.remove();
    const attributes = this.#attributes.get(node)!;
    for (const value of attributes.values()) this.#bytes -= value.length * 2;
    this.#attributes.delete(node);
    this.#bytes -= 128;
    this.#instrumentation.selectionTraceNodesRemoved += 1;
  }

  private write(node: SVGElement, name: string, value: string | null): void {
    const attributes = this.#attributes.get(node)!;
    const previous = attributes.get(name) ?? null;
    if (previous === value) return;
    if (value === null) {
      node.removeAttribute(name);
      attributes.delete(name);
    } else {
      node.setAttribute(name, value);
      attributes.set(name, value);
    }
    this.#bytes += ((value?.length ?? 0) - (previous?.length ?? 0)) * 2;
    this.#instrumentation.attributeWrites += 1;
    this.#instrumentation.selectionTraceAttributeWrites += 1;
  }
}
