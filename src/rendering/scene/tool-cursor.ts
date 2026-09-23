import type { ColorV1 } from "../../domain/schema/public";
import { SVG_NAMESPACE } from "./constants";
import type { MutableSceneInstrumentation } from "./types";

/** Cursor geometry uses SVG-local CSS pixels, independent of the camera. */
export type SceneToolCursor = { readonly x: number; readonly y: number } & (
  | {
      readonly kind: "tool";
      readonly color: ColorV1;
      readonly opacity: number;
      readonly fillColor?: ColorV1 | null;
      readonly fillOpacity?: number;
      readonly icon: SVGSVGElement | undefined;
    }
  | { readonly kind: "eraser"; readonly radius: number }
);

export interface SceneToolCursorFrame {
  readonly cursor: SceneToolCursor | null;
  readonly system: string;
}

export type SceneToolCursorFrameReader = (layoutChanged: boolean) => SceneToolCursorFrame;

export interface SceneToolCursorDom {
  readonly group: SVGGElement;
  readonly ring: SVGCircleElement;
  readonly icon: SVGGElement;
}

export function createToolCursorDom(document: Document): SceneToolCursorDom {
  const group = document.createElementNS(SVG_NAMESPACE, "g");
  group.setAttribute("class", "inkbook-tool-cursor");
  group.setAttribute("display", "none");
  group.setAttribute("pointer-events", "none");
  const ring = document.createElementNS(SVG_NAMESPACE, "circle");
  ring.setAttribute("fill", "none");
  ring.setAttribute("stroke", "var(--inkbook-text)");
  ring.setAttribute("stroke-dasharray", "4 3");
  ring.setAttribute("visibility", "hidden");
  group.append(ring);
  const icon = document.createElementNS(SVG_NAMESPACE, "g");
  icon.setAttribute("transform", "translate(10 -28)");
  icon.setAttribute("visibility", "hidden");
  group.append(icon);
  return { group, ring, icon };
}

/** Retained decorations and icon; pointer frames change only the group transform. */
export class SceneToolCursorWriter {
  #pending: SceneToolCursor | null = null;
  #dirty = false;
  #icon: SVGSVGElement | undefined;
  #fillNodes: SVGElement[] = [];
  readonly #applied = new Map<SVGElement, Map<string, string>>();

  public constructor(
    private readonly dom: SceneToolCursorDom,
    private readonly instrumentation: MutableSceneInstrumentation,
  ) {}

  public set(state: SceneToolCursor | null): void {
    this.#pending = state;
    this.#dirty = true;
  }

  /** Position-only input update; pending presentation changes remain frame-owned. */
  public move(x: number, y: number): void {
    if (this.#dirty || this.#pending === null) return;
    this.attribute(this.dom.group, "transform", `translate(${String(x)} ${String(y)})`);
  }

  public release(): void {
    this.#pending = null;
    this.#dirty = false;
    this.#icon?.remove();
    this.#icon = undefined;
    this.#fillNodes = [];
    this.#applied.clear();
  }

  public write(): void {
    if (!this.#dirty) return;
    this.#dirty = false;
    const state = this.#pending;
    // SVG children can override inherited visibility, but cannot override ancestor display.
    this.attribute(this.dom.group, "display", state === null ? "none" : "inline");
    if (state === null) return;
    this.attribute(this.dom.group, "transform", `translate(${String(state.x)} ${String(state.y)})`);
    const eraser = state.kind === "eraser";
    this.attribute(this.dom.ring, "visibility", eraser ? "visible" : "hidden");
    this.attribute(this.dom.icon, "visibility", eraser ? "hidden" : "visible");
    if (eraser) this.attribute(this.dom.ring, "r", String(state.radius));
    else this.writeIcon(state);
  }

  private writeIcon(state: Extract<SceneToolCursor, { kind: "tool" }>): void {
    if (this.#icon !== state.icon) {
      if (this.#icon !== undefined) {
        this.#icon.remove();
        this.#applied.delete(this.#icon);
        for (const node of this.#fillNodes) this.#applied.delete(node);
      }
      this.#icon = state.icon;
      this.#fillNodes = state.icon === undefined ? [] : iconGeometry(state.icon);
      if (state.icon !== undefined) {
        this.attribute(state.icon, "width", "18");
        this.attribute(state.icon, "height", "18");
        this.dom.icon.append(state.icon);
      }
    }
    this.attribute(this.dom.icon, "color", cursorColor(state.color));
    const closed = state.fillColor !== undefined;
    this.attribute(this.dom.icon, "opacity", String(closed ? 1 : state.opacity));
    this.attribute(this.dom.icon, "stroke-opacity", String(closed ? state.opacity : 1));
    if (closed) {
      for (const node of this.#fillNodes) {
        this.attribute(
          node,
          "fill",
          state.fillColor === null ? "none" : cursorColor(state.fillColor),
        );
        this.attribute(node, "fill-opacity", String(state.fillOpacity ?? 1));
      }
    }
  }

  private attribute(node: SVGElement, name: string, value: string): void {
    let applied = this.#applied.get(node);
    if (applied === undefined) {
      applied = new Map();
      this.#applied.set(node, applied);
    }
    if (applied.get(name) === value) return;
    node.setAttribute(name, value);
    applied.set(name, value);
    this.instrumentation.attributeWrites += 1;
  }
}

function cursorColor(color: ColorV1): string {
  return color.type === "theme-text" ? "var(--inkbook-text)" : color.value;
}

/** Called only when the retained toolbar icon changes, including nested registered SVGs. */
function iconGeometry(root: SVGElement): SVGElement[] {
  const geometry: SVGElement[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (["path", "rect", "ellipse", "circle", "polygon", "polyline"].includes(node.tagName)) {
      geometry.push(node);
    }
    // One-time traversal of a new detached toolbar icon, never scene reconciliation.
    // eslint-disable-next-line no-restricted-syntax -- Inspect only a newly attached toolbar icon, never retained scene content.
    for (const child of Array.from(node.children)) pending.push(child as SVGElement);
  }
  return geometry;
}
