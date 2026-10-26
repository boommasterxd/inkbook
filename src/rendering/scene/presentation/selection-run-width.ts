import { SVG_NAMESPACE } from "../constants";
import { scaledDashPattern, scaledStrokeWidth } from "../content/element-presentation";
import type { MountedSceneElement } from "../content/mounted-element";
import type { MutableSceneInstrumentation } from "../types";

// Validated v1 paint has seven outline/pen widths and five highlighter widths.
const MAX_WIDTH_VALUES = 12;
const MAX_DASH_VALUES = 14;
const MAX_ACTIVE_CONTAINERS = 4;
const ACTIVE_ATTRIBUTE = "data-inkbook-run-active";
const WIDTH_ATTRIBUTE = "data-inkbook-run-width";
const DASH_ATTRIBUTE = "data-inkbook-run-dash";
const propertyName = (kind: "width" | "dash", index: number): string =>
  `--inkbook-run-${kind}-${index}`;

type StyleState = { readonly value: string; readonly priority: string };
type PathState = {
  readonly width: string | null;
  readonly dash: string | null;
};
type ContainerState = {
  readonly marker: string | null;
  readonly palette: Map<string, StyleState>;
};

export interface SelectionRunWidthMemoryUsage {
  readonly trackedEntries: number;
  readonly trackedPaths: number;
  readonly widthPaletteEntries: number;
  readonly dashPaletteEntries: number;
  readonly paletteOverrides: number;
}

export interface SelectionRunWidthOptions {
  readonly svg: SVGSVGElement;
  readonly instrumentation: MutableSceneInstrumentation;
  readonly zoom: () => number;
}

/** Prepares inert path slots; only transformed run containers override native paint. */
export class SceneRunStrokeWidth {
  readonly #instrumentation: MutableSceneInstrumentation;
  readonly #zoom: () => number;
  readonly #svg: SVGSVGElement;
  #style: SVGStyleElement | undefined;
  #owned = new Map<string, Map<SVGPathElement, PathState>>();
  #active = new Map<SVGGElement, ContainerState>();
  #widthValues = new Map<string, number>();
  #dashValues = new Map<string, number>();
  #trackedPaths = 0;
  #paletteOverrides = 0;
  #lastZoom: number | null = null;

  public constructor(options: SelectionRunWidthOptions) {
    this.#instrumentation = options.instrumentation;
    this.#zoom = options.zoom;
    this.#svg = options.svg;
  }

  /** Admitted scene work only. Slot attributes leave untransformed paint untouched. */
  public prepare(entry: MountedSceneElement): void {
    this.#ensureStyle();
    this.refreshZoom();
    const owned = this.#owned.get(entry.id) ?? new Map<SVGPathElement, PathState>();
    const current = new Set<SVGPathElement>();
    for (const path of entry.paths) {
      const presentation = path.appliedPresentation;
      const width = presentation["stroke-width"];
      if (width === null || presentation.stroke === "none") continue;
      const node = path.node;
      current.add(node);
      if (!owned.has(node)) {
        owned.set(node, {
          width: node.getAttribute(WIDTH_ATTRIBUTE),
          dash: node.getAttribute(DASH_ATTRIBUTE),
        });
        this.#trackedPaths += 1;
      }
      this.#writeAttribute(node, WIDTH_ATTRIBUTE, String(this.#paletteIndex(width, "width")));
      const dash = presentation["stroke-dasharray"];
      this.#writeAttribute(
        node,
        DASH_ATTRIBUTE,
        dash === null ? null : String(this.#paletteIndex(dash, "dash")),
      );
    }
    for (const [node, state] of owned) {
      if (current.has(node)) continue;
      this.#restorePath(node, state);
      owned.delete(node);
      this.#trackedPaths -= 1;
    }
    if (owned.size === 0) this.#owned.delete(entry.id);
    else this.#owned.set(entry.id, owned);
    this.#clearIdlePalette();
  }

  /** O(1) member work: mark only actual transformed prefixes/suffixes, never paths.
   * Clear before a container is removed/reused; identity containers must stay idle. */
  public setActive(container: SVGGElement, active: boolean): void {
    const previous = this.#active.get(container);
    if (!active) {
      if (previous === undefined) return;
      this.#writeAttribute(container, ACTIVE_ATTRIBUTE, previous.marker);
      for (const [property, state] of previous.palette) {
        this.#writeStyle(container, property, state.value || null, state.priority);
      }
      this.#paletteOverrides -= previous.palette.size;
      this.#active.delete(container);
      this.#clearIdlePalette();
      return;
    }
    this.refreshZoom();
    if (previous !== undefined) return;
    if (this.#active.size >= MAX_ACTIVE_CONTAINERS)
      throw new Error("Selection paint requires at most four active run containers.");
    const state: ContainerState = {
      marker: container.getAttribute(ACTIVE_ATTRIBUTE),
      palette: new Map(),
    };
    this.#active.set(container, state);
    this.#writeContainerPalette(container, finiteZoom(this.#zoom()));
    this.#writeAttribute(container, ACTIVE_ATTRIBUTE, "");
    this.#lastZoom = finiteZoom(this.#zoom());
  }

  /** Finite active-container palette only; idle zoom does no reads or writes. */
  public refreshZoom(): void {
    if (this.#active.size === 0) return;
    const zoom = finiteZoom(this.#zoom());
    if (zoom === this.#lastZoom) return;
    for (const container of this.#active.keys()) this.#writeContainerPalette(container, zoom);
    this.#lastZoom = zoom;
  }

  public release(entry: MountedSceneElement): void {
    const owned = this.#owned.get(entry.id);
    if (owned === undefined) return;
    for (const [node, state] of owned) this.#restorePath(node, state);
    this.#trackedPaths -= owned.size;
    this.#owned.delete(entry.id);
    this.#clearIdlePalette();
  }

  public memoryUsage(): SelectionRunWidthMemoryUsage {
    return {
      trackedEntries: this.#owned.size,
      trackedPaths: this.#trackedPaths,
      widthPaletteEntries: this.#widthValues.size,
      dashPaletteEntries: this.#dashValues.size,
      paletteOverrides: this.#paletteOverrides,
    };
  }

  /** The renderer discarded its DOM. Do not walk paths or normalize containers. */
  public discard(): void {
    this.#style?.remove();
    this.#style = undefined;
    this.#owned = new Map();
    this.#active = new Map();
    this.#widthValues = new Map();
    this.#dashValues = new Map();
    this.#trackedPaths = 0;
    this.#paletteOverrides = 0;
    this.#lastZoom = null;
  }

  #ensureStyle(): void {
    if (this.#style !== undefined) return;
    // Allocate only during admitted cohort preparation, never idle scene creation.
    // Fixed rules share the isolated SVG document's stylesheet lifecycle.
    this.#style = this.#svg.ownerDocument.createElementNS(SVG_NAMESPACE, "style");
    this.#style.textContent = paintRules();
    this.#svg.append(this.#style);
  }

  #paletteIndex(base: string, kind: "width" | "dash"): number {
    const values = kind === "width" ? this.#widthValues : this.#dashValues;
    const current = values.get(base);
    if (current !== undefined) return current;
    const limit = kind === "width" ? MAX_WIDTH_VALUES : MAX_DASH_VALUES;
    if (values.size >= limit) throw new Error("Validated paint palette exceeds v1 schema bounds.");
    const index = values.size;
    values.set(base, index);
    const zoom = finiteZoom(this.#zoom());
    for (const container of this.#active.keys())
      this.#writePalette(container, kind, base, index, zoom);
    return index;
  }

  #writeContainerPalette(container: SVGGElement, zoom: number): void {
    for (const [base, index] of this.#widthValues)
      this.#writePalette(container, "width", base, index, zoom);
    for (const [base, index] of this.#dashValues)
      this.#writePalette(container, "dash", base, index, zoom);
  }

  #writePalette(
    container: SVGGElement,
    kind: "width" | "dash",
    base: string,
    index: number,
    zoom: number,
  ): void {
    const property = propertyName(kind, index);
    const palette = this.#active.get(container)!.palette;
    if (!palette.has(property)) {
      palette.set(property, {
        value: container.style.getPropertyValue(property),
        priority: container.style.getPropertyPriority?.(property) ?? "",
      });
      this.#paletteOverrides += 1;
    }
    const value = kind === "width" ? scaledStrokeWidth(base, zoom) : scaledDashPattern(base, zoom);
    this.#writeStyle(container, property, value ?? base);
  }

  #clearIdlePalette(): void {
    if (this.#active.size === 0) this.#lastZoom = null;
    if (this.#active.size > 0 || this.#owned.size > 0) return;
    this.#widthValues.clear();
    this.#dashValues.clear();
  }

  #restorePath(node: SVGPathElement, state: PathState): void {
    this.#writeAttribute(node, WIDTH_ATTRIBUTE, state.width);
    this.#writeAttribute(node, DASH_ATTRIBUTE, state.dash);
  }

  #writeAttribute(node: SVGElement, name: string, value: string | null): void {
    if (node.getAttribute(name) === value) return;
    if (value === null) node.removeAttribute(name);
    else node.setAttribute(name, value);
    this.#countWrite();
  }

  #writeStyle(node: SVGElement, property: string, value: string | null, priority = ""): void {
    if (
      node.style.getPropertyValue(property) === (value ?? "") &&
      (node.style.getPropertyPriority?.(property) ?? "") === (value === null ? "" : priority)
    )
      return;
    if (value === null) node.style.removeProperty(property);
    else node.style.setProperty(property, value, priority);
    this.#countWrite();
  }

  #countWrite(): void {
    this.#instrumentation.attributeWrites += 1;
    this.#instrumentation.contentAttributeWrites += 1;
  }
}

function paintRules(): string {
  const scope = `[${ACTIVE_ATTRIBUTE}]`;
  const rules = [`${scope} [${WIDTH_ATTRIBUTE}]{vector-effect:non-scaling-stroke}`];
  for (let index = 0; index < MAX_WIDTH_VALUES; index += 1)
    rules.push(
      `${scope} [${WIDTH_ATTRIBUTE}="${index}"]{stroke-width:var(${propertyName("width", index)})}`,
    );
  for (let index = 0; index < MAX_DASH_VALUES; index += 1)
    rules.push(
      `${scope} [${DASH_ATTRIBUTE}="${index}"]{stroke-dasharray:var(${propertyName("dash", index)})}`,
    );
  return rules.join("\n");
}

function finiteZoom(zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}
