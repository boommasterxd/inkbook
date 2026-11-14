import { sameBounds as sameWindow } from "../visibility/visibility-bounds";
import type { ColorV1, TextElementV2, TextStyleV2 } from "../../../domain/schema/types";
import { SVG_NAMESPACE } from "../constants";
import type { MutableSceneInstrumentation } from "../types";
import { writeRaw } from "./mounted-path";
import { fontCssFamily, fontResourceCssFamily } from "../../../domain/text/font-family";
import { textStyleAt, textStyleSegmentsSteps } from "../../../domain/text/text-style-segments";
import { textBackgroundGeometrySteps } from "../../../domain/geometry/text-backgrounds";
import {
  textBackgroundBoxPath,
  textBackgroundRadius,
} from "../../../domain/geometry/rounded-background-path";
import { textTableGridPathSteps } from "../../../domain/geometry/text-table-grid-path";
import type { AffineMatrix } from "../../../domain/geometry/affine-matrix";
import type { Bounds } from "../../../domain/geometry/primitives";
import { MountedTextLines } from "./mounted-text-lines";

/** One retained paint root, shared with the singleton runtime editing surface. */
export class MountedTextPresentation {
  public previewMatrix: AffineMatrix | undefined;
  public motionScale = 1;
  public readonly group: SVGGElement;
  public readonly content: SVGGElement;
  readonly #background: SVGPathElement;
  readonly #stats: MutableSceneInstrumentation;
  #element: TextElementV2 | undefined;
  #bytes = 0;
  #scratchBytes = 0;
  #origin = { x: 0, y: 0 };
  #backgroundShape: string | undefined;
  #pending: { element: TextElementV2; steps: Generator<void> } | undefined;
  #paintNodes: readonly SVGElement[] = [];
  #lineOffset = 0;
  #lines: MountedTextLines | undefined;
  #stagedLines: MountedTextLines | undefined;
  #window: Bounds | undefined;
  #viewportWork:
    { bounds: Bounds | undefined; lines: MountedTextLines; steps: Generator<void> } | undefined;

  public constructor(
    document: Document,
    element: TextElementV2,
    stats: MutableSceneInstrumentation,
    deferred = false,
    private readonly viewport?: (
      element: TextElementV2,
      detachedPreview?: AffineMatrix,
    ) => Bounds | undefined,
  ) {
    this.#stats = stats;
    this.group = document.createElementNS(SVG_NAMESPACE, "g");
    this.write(this.group, "class", "inkbook-native-text");
    this.#background = document.createElementNS(SVG_NAMESPACE, "path");
    this.content = document.createElementNS(SVG_NAMESPACE, "g");
    this.group.append(this.#background, this.content);
    if (!deferred) this.update(element);
  }

  public memoryUsage(): number {
    return (
      this.#bytes +
      this.#scratchBytes +
      (this.#lines?.memoryUsage() ?? 0) +
      (this.#stagedLines?.memoryUsage() ?? 0) +
      (this.#viewportWork?.lines.memoryUsage() ?? 0)
    );
  }
  public get element(): TextElementV2 {
    return this.#element!;
  }
  public motionSnapshot(element: TextElementV2, maximumNodes: number, maximumBytes: number) {
    if (
      this.#element !== element ||
      this.#lines?.complete !== true ||
      this.memoryUsage() > maximumBytes ||
      this.#paintNodes.length + this.#lines.nodeCount + 3 > maximumNodes
    )
      return undefined;
    const root = this.group.cloneNode(false) as SVGGElement;
    root.removeAttribute("data-inkbook-text-editor-ready");
    root.style.removeProperty("opacity");
    root.style.removeProperty("transform");
    const content = this.content.cloneNode(false) as SVGGElement;
    content.removeAttribute("visibility");
    const background = this.#background.cloneNode(false) as SVGPathElement;
    root.append(background, content);
    const nodes: SVGElement[] = [root, background, content];
    const clones = new Map<SVGElement, SVGElement>([[this.content, content]]);
    for (const node of this.paintNodes()) {
      const clone = node.cloneNode(false) as SVGElement;
      if (node.localName === "tspan") clone.textContent = node.textContent;
      clones.get(node.parentNode as SVGElement)?.append(clone);
      clones.set(node, clone);
      nodes.push(clone);
    }
    return { root, nodes, bytes: this.memoryUsage() };
  }

  public update(element: TextElementV2): void {
    while (!this.prepare(element, Infinity, () => 0)) {
      /* Synchronous compatibility for bounded previews. */
    }
  }

  public cancelPreparation(): void {
    this.#pending?.steps.return(undefined);
    this.#pending = undefined;
    this.#scratchBytes = 0;
    this.#stagedLines = undefined;
    this.cancelViewport();
  }

  /** The content lane supplies the same admitted deadline used for native geometry preparation. */
  public prepareViewport(deadline: number, now: () => number): boolean {
    if (!this.#element || this.#pending) return this.#pending === undefined;
    if (this.#lines?.windowed === false) return true;
    const bounds = this.viewport?.(this.#element, this.previewMatrix);
    if (coversWindow(this.#window, bounds)) {
      this.cancelViewport();
      return true;
    }
    if (!this.#viewportWork || !coversWindow(this.#viewportWork.bounds, bounds)) {
      this.cancelViewport();
      const lines = this.createLines({ ...this.#element, x: this.#origin.x, y: this.#origin.y });
      const retained = reserveWindow(bounds, this.#element.style.fontSize);
      this.#viewportWork = { bounds: retained, lines, steps: lines.prepare(retained, this.#lines) };
    }
    do {
      if (this.#viewportWork.steps.next().done) {
        const { lines } = this.#viewportWork;
        const parent = this.#paintNodes[0] as SVGGElement;
        lines.publish(parent, this.#paintNodes[this.#lineOffset] ?? null, this.#lines);
        this.#lines = lines;
        this.#window = this.#viewportWork.bounds;
        this.#viewportWork = undefined;
        return true;
      }
    } while (now() < deadline);
    return false;
  }

  public prepare(element: TextElementV2, deadline: number, now: () => number): boolean {
    if (this.#element === element) {
      this.cancelPreparation();
      return true;
    }
    const previous = this.#element;
    if (
      previous?.layout === element.layout &&
      previous.style === element.style &&
      previous.ranges === element.ranges &&
      (this.#backgroundShape === undefined ||
        (previous.backgroundColor === element.backgroundColor &&
          previous.backgroundOpacity === element.backgroundOpacity))
    ) {
      this.cancelPreparation();
      return this.finishPosition(element);
    }
    if (this.#pending?.element !== element) {
      this.cancelPreparation();
      this.#pending = { element, steps: this.buildSteps(element) };
    }
    do {
      if (this.#pending.steps.next().done) {
        this.#pending = undefined;
        this.#bytes = this.#scratchBytes;
        this.#scratchBytes = 0;
        return this.finishPosition(element);
      }
    } while (now() < deadline);
    return false;
  }

  private finishPosition(element: TextElementV2): true {
    this.#element = element;
    this.updateBackground(element);
    const dx = element.x - this.#origin.x;
    const dy = element.y - this.#origin.y;
    this.write(this.content, "transform", dx === 0 && dy === 0 ? null : `translate(${dx} ${dy})`);
    return true;
  }

  private *buildSteps(element: TextElementV2): Generator<void> {
    const scratch = this.content.ownerDocument.createElementNS(SVG_NAMESPACE, "g");
    this.#scratchBytes = 2048;
    const backgrounds = yield* textBackgroundGeometrySteps(element);
    const nodes: SVGElement[] = [scratch];
    for (const paint of backgrounds.paints) {
      const path = this.content.ownerDocument.createElementNS(SVG_NAMESPACE, "path");
      this.write(path, "d", paint.d);
      this.color(path, paint.color);
      this.write(path, "fill-opacity", String(paint.opacity));
      scratch.append(path);
      nodes.push(path);
      this.#scratchBytes += 512 + paint.d.length * 2;
      yield;
    }
    const lineOffset = nodes.length;
    const window = reserveWindow(this.viewport?.(element), element.style.fontSize);
    const lines = this.createLines(element);
    this.#stagedLines = lines;
    yield* lines.prepare(window, this.#lines);
    yield* this.appendTables(element, scratch, nodes);
    yield* this.appendMath(element, scratch, nodes);
    lines.publish(scratch, nodes[lineOffset] ?? null);
    this.content.replaceChildren(scratch);
    this.#paintNodes = nodes;
    this.#lineOffset = lineOffset;
    this.#lines = lines;
    this.#stagedLines = undefined;
    this.#window = window;
    this.#origin = { x: element.x, y: element.y };
    this.#backgroundShape = backgrounds.basePath;
    this.#scratchBytes += backgrounds.basePath?.length ? backgrounds.basePath.length * 2 : 0;
  }

  private createLines(element: TextElementV2): MountedTextLines {
    return new MountedTextLines(element, {
      document: this.content.ownerDocument,
      write: (node, name, value) => this.write(node, name, value),
      style: (node, style, font) => this.style(node, style, font),
      onText: () => {
        this.#stats.contentGeometryWrites += 1;
      },
    });
  }

  private *paintNodes(): Generator<SVGElement> {
    for (let index = 0; index < this.#paintNodes.length; index += 1) {
      if (index === this.#lineOffset) yield* this.#lines!.nodes();
      yield this.#paintNodes[index]!;
    }
    if (this.#lineOffset === this.#paintNodes.length) yield* this.#lines!.nodes();
  }

  public cancelViewport(): void {
    this.#viewportWork?.steps.return(undefined);
    this.#viewportWork = undefined;
  }

  private *appendTables(
    element: TextElementV2,
    scratch: SVGGElement,
    nodes: SVGElement[],
  ): Generator<void> {
    for (const table of element.layout.tables ?? []) {
      const d = yield* textTableGridPathSteps(table);
      if (d === "") continue;
      const path = this.content.ownerDocument.createElementNS(SVG_NAMESPACE, "path");
      this.write(path, "d", d);
      this.write(path, "transform", `translate(${element.x} ${element.y})`);
      this.color(path, element.style.color);
      this.write(path, "fill-opacity", String(element.style.opacity));
      scratch.append(path);
      nodes.push(path);
      this.#scratchBytes += 512 + d.length * 2;
      yield;
    }
  }

  private *appendMath(
    element: TextElementV2,
    scratch: SVGGElement,
    nodes: SVGElement[],
  ): Generator<void> {
    if (element.layout.math === undefined || element.layout.math.length === 0) return;
    const segments = yield* textStyleSegmentsSteps(element.ranges, element.source.length);
    for (const math of element.layout.math ?? []) {
      const group = this.content.ownerDocument.createElementNS(SVG_NAMESPACE, "g");
      nodes.push(group);
      this.write(group, "transform", `translate(${element.x + math.x} ${element.y + math.y})`);
      const style = { ...element.style, ...textStyleAt(segments, math.start) };
      this.color(group, style.color);
      this.write(group, "fill-opacity", String(style.opacity));
      for (const path of math.paths) {
        const node = this.content.ownerDocument.createElementNS(SVG_NAMESPACE, "path");
        this.write(node, "d", path.d);
        this.write(node, "fill-rule", path.fillRule ?? "nonzero");
        group.append(node);
        nodes.push(node);
        this.#scratchBytes += 512 + path.d.length * 2;
        yield;
      }
      scratch.append(group);
      this.#scratchBytes += 512;
    }
  }

  private updateBackground(element: TextElementV2): void {
    this.write(
      this.#background,
      "d",
      this.#backgroundShape ??
        textBackgroundBoxPath(element, textBackgroundRadius(element, element.style.fontSize)),
    );
    const dx = element.x - this.#origin.x;
    const dy = element.y - this.#origin.y;
    this.write(
      this.#background,
      "transform",
      this.#backgroundShape === undefined || (dx === 0 && dy === 0)
        ? null
        : `translate(${dx} ${dy})`,
    );
    this.color(this.#background, element.backgroundColor);
    this.write(this.#background, "fill-opacity", String(element.backgroundOpacity));
  }

  private style(node: SVGElement, style: TextStyleV2, fontResourceId?: string): void {
    this.write(
      node,
      "font-family",
      fontResourceId === undefined
        ? fontCssFamily(style.fontFamily)
        : fontResourceCssFamily(fontResourceId),
    );
    this.write(node, "font-size", String(style.fontSize));
    this.write(node, "font-weight", style.bold ? "700" : "400");
    this.write(node, "font-style", style.italic ? "italic" : "normal");
    this.write(
      node,
      "text-decoration",
      [style.underline ? "underline" : "", style.strikethrough ? "line-through" : ""]
        .filter(Boolean)
        .join(" ") || "none",
    );
    this.write(node, "fill-opacity", String(style.opacity));
    this.color(node, style.color);
  }

  private color(node: SVGElement, color: ColorV1 | null): void {
    this.write(
      node,
      "fill",
      color === null ? "none" : color.type === "theme-text" ? "#222222FF" : color.value,
    );
    this.write(node, "class", color?.type === "theme-text" ? "inkbook-theme-fill" : null);
  }

  private write(node: SVGElement, name: string, value: string | null): void {
    if (node.getAttribute(name) === value) return;
    writeRaw(node, name, value, this.#stats, true);
  }
}

/** Explicit page-space origin keeps CSS motion identical to the native SVG rotation. */
export function setTextMotionOrigin(node: SVGElement, element: TextElementV2 | null): string {
  if (element === null) {
    node.style.removeProperty("transform-origin");
    return "";
  }
  node.style.setProperty("transform-origin", `${element.pivot.x}px ${element.pivot.y}px`);
  return `rotate(${element.rotation}deg) `;
}

function coversWindow(retained: Bounds | undefined, requested: Bounds | undefined): boolean {
  return (
    sameWindow(retained, requested) ||
    (retained !== undefined &&
      requested !== undefined &&
      retained.minX <= requested.minX &&
      retained.minY <= requested.minY &&
      retained.maxX >= requested.maxX &&
      retained.maxY >= requested.maxY)
  );
}

/** Match the line index's font-overhang reserve so small viewport retargets keep admitted work. */
function reserveWindow(bounds: Bounds | undefined, fontSize: number): Bounds | undefined {
  const reserve = fontSize * 2;
  return (
    bounds && {
      minX: bounds.minX - reserve,
      minY: bounds.minY - reserve,
      maxX: bounds.maxX + reserve,
      maxY: bounds.maxY + reserve,
    }
  );
}
