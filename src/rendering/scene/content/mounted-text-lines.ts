import type { Bounds } from "../../../domain/geometry/primitives";
import type {
  TextElementV2,
  TextLayoutLineV2,
  TextRangeStyleV2,
  TextStyleV2,
} from "../../../domain/schema/types";
import { MAX_MOTION_PATHS, SVG_NAMESPACE } from "../constants";
import { TextLineIndex } from "./text-line-index";
import { writeAutoPaintBounds } from "./auto-paint-bounds";
import { textRunPaintBounds } from "../../../domain/geometry/text-paint-bounds";

interface LineNode {
  readonly line: TextLayoutLineV2;
  readonly root: SVGTextElement;
  readonly nodes: readonly SVGElement[];
  readonly bytes: number;
}

interface TextLinePorts {
  readonly document: Document;
  readonly write: (node: SVGElement, name: string, value: string | null) => void;
  readonly style: (node: SVGElement, style: TextStyleV2, font?: string) => void;
  readonly onText: () => void;
}

/** Only the current window owns native nodes; discarded windows retain no detached line cache. */
export class MountedTextLines {
  readonly #lines = new Map<number, LineNode>();
  #index: TextLineIndex | undefined;
  #indexBytes = 0;
  #nodeBytes = 0;
  #nodeCount = 0;

  public constructor(
    public readonly element: TextElementV2,
    private readonly ports: TextLinePorts,
  ) {}

  public get complete(): boolean {
    return this.#lines.size === this.#index?.count;
  }

  public get windowed(): boolean {
    return this.#index === undefined || this.#index.nodeCount + 4 > MAX_MOTION_PATHS;
  }

  public memoryUsage(): number {
    return this.#nodeBytes + this.#indexBytes;
  }

  public get nodeCount(): number {
    return this.#nodeCount;
  }

  public *nodes(): Generator<SVGElement> {
    for (const line of this.#lines.values()) yield* line.nodes;
  }

  public *prepare(bounds: Bounds | undefined, previous?: MountedTextLines): Generator<void> {
    if (
      previous?.element.layout === this.element.layout &&
      previous.element.style.fontSize === this.element.style.fontSize
    ) {
      this.#index = previous.#index;
    }
    if (this.#index === undefined) {
      let leaf = 1;
      while (leaf < this.element.layout.lines.length) leaf *= 2;
      this.#indexBytes = leaf * 66 + 64;
      this.#index = yield* TextLineIndex.prepare(this.element);
    }
    this.#indexBytes = this.#index.memoryUsage();
    const sameOrigin =
      previous?.element.x === this.element.x && previous.element.y === this.element.y;
    const sameStyle =
      previous !== undefined && stylesEqual(previous.element.style, this.element.style);
    for (const index of this.#index.query(this.windowed ? bounds : undefined)) {
      if (index !== undefined) {
        const line = this.element.layout.lines[index]!;
        const retained =
          sameOrigin && sameStyle && previous ? previous.#lines.get(index) : undefined;
        const node =
          retained && (yield* sameLine(retained.line, line))
            ? { ...retained, line }
            : yield* this.createLine(line);
        this.#lines.set(index, node);
        this.#nodeCount += node.nodes.length;
        if (retained && node.root === retained.root) this.#nodeBytes += node.bytes;
      }
      yield;
    }
  }

  /** Keep overlapping lines in place; publish only completed native nodes in original paint order. */
  public publish(
    parent: SVGGElement,
    anchor: SVGElement | null,
    previous?: MountedTextLines,
  ): void {
    if (previous) {
      for (const [index, line] of previous.#lines) {
        if (this.#lines.get(index)?.root !== line.root) line.root.remove();
      }
    }
    const lines = [...this.#lines.values()];
    let next: SVGElement | null = anchor;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const root = lines[index]!.root;
      if (root.parentNode !== parent) parent.insertBefore(root, next);
      next = root;
    }
  }

  private *createLine(line: TextLayoutLineV2): Generator<void, LineNode> {
    const { document, write, style, onText } = this.ports;
    const root = document.createElementNS(SVG_NAMESPACE, "text");
    const nodes: SVGElement[] = [root];
    let bytes = 512;
    this.#nodeBytes += 512;
    write(root, "xml:space", "preserve");
    for (const run of line.runs) {
      const span = document.createElementNS(SVG_NAMESPACE, "tspan");
      if ((run.style?.color ?? this.element.style.color).type === "theme-text")
        writeAutoPaintBounds(
          span,
          run.inkBounds === undefined ? undefined : textRunPaintBounds(this.element, line, run),
        );
      write(span, "x", String(this.element.x + line.x + run.x));
      write(span, "y", String(this.element.y + line.y + line.baseline));
      if (run.text.length && run.width > 0) {
        write(span, "textLength", String(run.width));
        write(span, "lengthAdjust", "spacingAndGlyphs");
      }
      style(span, { ...this.element.style, ...run.style }, run.fontResourceId);
      span.textContent = run.text;
      onText();
      bytes += 512 + run.text.length * 2;
      this.#nodeBytes += 512 + run.text.length * 2;
      root.append(span);
      nodes.push(span);
      yield;
    }
    return { root, nodes, bytes, line };
  }
}

function* sameLine(left: TextLayoutLineV2, right: TextLayoutLineV2): Generator<void, boolean> {
  if (left === right) return true;
  if (
    left.x !== right.x ||
    left.y !== right.y ||
    left.width !== right.width ||
    left.height !== right.height ||
    left.baseline !== right.baseline ||
    left.runs.length !== right.runs.length
  )
    return false;
  for (let index = 0; index < left.runs.length; index += 1) {
    const a = left.runs[index]!;
    const b = right.runs[index]!;
    if (
      a.text !== b.text ||
      a.x !== b.x ||
      a.width !== b.width ||
      a.start !== b.start ||
      a.end !== b.end ||
      a.fontResourceId !== b.fontResourceId ||
      !stylesEqual(a.style, b.style)
    )
      return false;
    yield;
  }
  return true;
}

function stylesEqual(
  left: TextRangeStyleV2 | undefined,
  right: TextRangeStyleV2 | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const keys = Object.keys(left) as (keyof TextRangeStyleV2)[];
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => {
    const a = left[key];
    const b = right[key];
    return (
      a === b ||
      (a !== null &&
        b !== null &&
        typeof a === "object" &&
        typeof b === "object" &&
        a.type === b.type &&
        (a.type === "theme-text" || (b.type === "rgba" && a.value === b.value)))
    );
  });
}
