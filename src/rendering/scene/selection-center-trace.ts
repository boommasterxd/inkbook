import { buildLinearPathParts, type SvgPathPart } from "../../domain/geometry/element-path";
import { SelectionCenterCache } from "./selection-center-cache";
import type { InkElementV1, StrokeElementV1 } from "../../domain/schema/public";
import { SVG_NAMESPACE } from "./constants";
import type { MountedSceneElement } from "./mounted-element";
import type { MutableSceneInstrumentation } from "./types";

/** One screen-sized indicator follows displayed center geometry, independently of ink paint. */
export class SelectionCenterTrace {
  public readonly node: SVGGElement;
  readonly #path: SVGPathElement;
  readonly #attributes = new Map<SVGElement, Map<string, string>>();
  readonly #instrumentation: MutableSceneInstrumentation;
  readonly #cache: SelectionCenterCache;
  #basis: InkElementV1 | undefined;
  #parts: readonly SvgPathPart[] | undefined;
  #bytes = 256;

  public constructor(
    parent: SVGGElement,
    entry: MountedSceneElement,
    instrumentation: MutableSceneInstrumentation,
    cache: SelectionCenterCache,
  ) {
    this.#cache = cache;
    this.#instrumentation = instrumentation;
    this.node = parent.ownerDocument.createElementNS(SVG_NAMESPACE, "g");
    this.#path = parent.ownerDocument.createElementNS(SVG_NAMESPACE, "path");
    this.#attributes.set(this.node, new Map());
    this.#attributes.set(this.#path, new Map());
    this.write(this.node, "data-selection-element-id", entry.id);
    for (const [name, value] of Object.entries({
      class: "inkbook-selection-center-trace",
      fill: "none",
      "stroke-width": "1.5",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "vector-effect": "non-scaling-stroke",
    }))
      this.write(this.#path, name, value);
    this.node.append(this.#path);
    parent.append(this.node);
    instrumentation.selectionTraceNodesCreated += 2;
  }

  public memoryUsage(): number {
    return this.#bytes;
  }

  public get elementKind(): InkElementV1["kind"] | undefined {
    return this.#basis?.kind;
  }

  public update(
    entry: MountedSceneElement,
    element: InkElementV1,
    parts: readonly SvgPathPart[],
  ): void {
    if (this.needsGeometry(element, parts)) {
      let path: string;
      if (element.kind === "stroke" && element.style.pressureEnabled) {
        const cached = this.#cache.read(element);
        path = cached ?? this.#cache.build(element);
        if (cached === undefined) this.#instrumentation.selectionTraceGeometryBuilds += 1;
      } else {
        const geometry =
          element.kind === "arrow" ? buildLinearPathParts(element, "centerline") : parts;
        if (element.kind === "arrow") this.#instrumentation.selectionTraceGeometryBuilds += 1;
        path = geometry.map(({ d }) => d).join("");
      }
      this.write(this.#path, "d", path);
    }
    this.#basis = element;
    this.#parts = parts;
    this.transform(entry.appliedPreviewTransform);
  }

  public transform(transform: string | null): void {
    this.write(this.#path, "transform", transform);
  }

  public release(): void {
    this.node.remove();
    this.#instrumentation.selectionTraceNodesRemoved += 2;
    this.#attributes.clear();
    this.#basis = undefined;
    this.#parts = undefined;
    this.#bytes = 0;
  }

  private needsGeometry(element: InkElementV1, parts: readonly SvgPathPart[]): boolean {
    const previous = this.#basis;
    if (previous === element && this.#parts === parts) return false;
    if (previous === undefined || previous.kind !== element.kind) return true;
    if (element.kind === "stroke" && element.style.pressureEnabled)
      return !sameStrokeCenters(previous as StrokeElementV1, element);
    return this.#parts !== parts;
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

function sameStrokeCenters(a: StrokeElementV1, b: StrokeElementV1): boolean {
  return (
    a.style.pressureEnabled === b.style.pressureEnabled &&
    a.points === b.points &&
    a.rotation === b.rotation &&
    a.pivot.x === b.pivot.x &&
    a.pivot.y === b.pivot.y &&
    a.style.width === b.style.width
  );
}
