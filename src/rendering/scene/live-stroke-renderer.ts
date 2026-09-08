import {
  FILE_SCHEMA_LIMITS,
  type StrokeElementV1,
  type StrokeStyleV1,
} from "../../domain/schema/public";
import { normalizeStrokePaint } from "../../domain/geometry/pressure-paint";
import type { SvgPathPart } from "../../domain/geometry/svg-path-part";
import { SVG_NAMESPACE } from "./constants";
import {
  liveStrokePresentation,
  PRESENTATION_ATTRIBUTES,
  type PathPresentation,
} from "./element-presentation";
import type {
  MutableSceneInstrumentation,
  SceneLiveStrokeChunk,
  SceneLiveStrokePreview,
} from "./types";

const MAX_LIVE_STROKE_CHUNKS = 512;
const MAX_LIVE_PATH_PARTS = 1;

export class SceneLiveStrokeRenderer {
  readonly #committed = new Map<string, { group: SVGGElement; chunks: number; tail: number }>();
  readonly #chunkNodes: SVGPathElement[][] = [];
  #chunkPathCount = 0;
  #disposed = false;
  #group: SVGGElement;
  readonly #host: SVGGElement;
  readonly #placeGroup: (band: "content" | "highlight") => void;
  readonly #instrumentation: MutableSceneInstrumentation;
  #lastChunk: SceneLiveStrokeChunk | undefined;
  #lastTail: SceneLiveStrokePreview["tail"] | undefined;
  readonly #ownerDocument: Document;
  #presentation: PathPresentation | undefined;
  #style: StrokeStyleV1 | undefined;
  #tailNodes: SVGPathElement[] = [];
  #tool: StrokeElementV1["tool"] | undefined;

  public constructor(
    ownerDocument: Document,
    group: SVGGElement,
    placeGroup: (band: "content" | "highlight") => void,
    instrumentation: MutableSceneInstrumentation,
  ) {
    this.#ownerDocument = ownerDocument;
    this.#host = group;
    this.#group = ownerDocument.createElementNS(SVG_NAMESPACE, "g");
    group.append(this.#group);
    this.#placeGroup = placeGroup;
    this.#instrumentation = instrumentation;
  }

  public update(
    preview: SceneLiveStrokePreview,
    style: StrokeStyleV1,
    tool: StrokeElementV1["tool"],
  ): void {
    this.assertActive();
    this.assertAppendOnly(preview);
    this.ensurePresentation(style, tool);
    this.#placeGroup(tool === "highlighter" ? "highlight" : "content");
    if (
      preview.finalizedChunks.length === this.#chunkNodes.length &&
      preview.tail === this.#lastTail
    ) {
      return;
    }
    this.validateEntrants(preview);
    this.appendChunks(preview);
    this.updateTail(preview.tail.geometry);
    this.#lastTail = preview.tail;
    this.#instrumentation.livePreviewUpdates += 1;
    this.#instrumentation.liveMaximumTailNodes = Math.max(
      this.#instrumentation.liveMaximumTailNodes,
      this.#tailNodes.length,
    );
  }

  public commit(id: string, parent: (band: "content" | "highlight") => SVGGElement): void {
    this.assertActive();
    if (this.#style === undefined) return;
    if (this.#committed.has(id) || this.#committed.size >= FILE_SCHEMA_LIMITS.elements) {
      throw new RangeError("Live stroke handoffs must have unique, document-bounded IDs.");
    }
    const group = this.#group;
    group.setAttribute("pointer-events", "none");
    parent(this.#tool === "highlighter" ? "highlight" : "content").append(group);
    this.#committed.set(id, {
      group,
      chunks: this.#chunkPathCount,
      tail: this.#tailNodes.length,
    });
    this.#chunkNodes.length = 0;
    this.#chunkPathCount = 0;
    this.#tailNodes = [];
    this.#group = this.#ownerDocument.createElementNS(SVG_NAMESPACE, "g");
    this.#host.append(this.#group);
    this.resetStrokeState();
  }

  public settleCommits(isComplete: (id: string) => boolean): void {
    for (const [id, entry] of this.#committed) {
      if (!isComplete(id)) continue;
      entry.group.remove();
      this.#instrumentation.liveChunkNodesRemoved += entry.chunks;
      this.#instrumentation.liveTailNodesRemoved += Number(entry.tail);
      this.#committed.delete(id);
    }
  }

  public clear(): void {
    this.removeAllNodes();
    this.resetStrokeState();
  }

  public revert(): void {
    this.clear();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.clear();
    this.settleCommits(() => true);
    this.#group.remove();
    this.#disposed = true;
  }

  private appendChunks(preview: SceneLiveStrokePreview): void {
    for (let index = this.#chunkNodes.length; index < preview.finalizedChunks.length; index += 1) {
      const chunk = preview.finalizedChunks[index];
      if (chunk === undefined) continue;
      const nodes = chunk.geometry.map((part) => this.createPath(part));
      for (const node of nodes) this.#group.insertBefore(node, this.#tailNodes[0] ?? null);
      this.#chunkNodes.push(nodes);
      this.#chunkPathCount += nodes.length;
      this.#lastChunk = chunk;
      this.#instrumentation.liveChunkNodesCreated += nodes.length;
    }
    this.#instrumentation.liveMaximumChunkNodes = Math.max(
      this.#instrumentation.liveMaximumChunkNodes,
      this.#chunkPathCount,
    );
  }

  private createPath(part: SvgPathPart): SVGPathElement {
    const node = this.#ownerDocument.createElementNS(SVG_NAMESPACE, "path");
    node.setAttribute("d", part.d);
    this.#instrumentation.attributeWrites += 1;
    const presentation = this.#presentation;
    if (presentation === undefined) throw new Error("Live stroke paint is not initialized.");
    for (const attribute of PRESENTATION_ATTRIBUTES) {
      const value = presentation[attribute];
      if (value === null) continue;
      node.setAttribute(attribute, value);
      this.#instrumentation.attributeWrites += 1;
    }
    return node;
  }

  private ensurePresentation(style: StrokeStyleV1, tool: StrokeElementV1["tool"]): void {
    if (this.#style !== undefined) {
      if (this.#tool !== tool || !sameStrokeStyle(this.#style, style)) {
        throw new Error("A live stroke cannot change paint after rendering starts.");
      }
      return;
    }
    this.#style = style;
    this.#tool = tool;
    const groupedStyle = { ...style, ...normalizeStrokePaint(style) };
    this.#group.setAttribute("opacity", String(groupedStyle.opacity));
    this.#instrumentation.attributeWrites += 1;
    this.#presentation = withoutPerPathOpacity(
      liveStrokePresentation(groupedStyle, style.pressureEnabled ? "fill" : "stroke", tool),
    );
  }

  private assertAppendOnly(preview: SceneLiveStrokePreview): void {
    const nextCount = preview.finalizedChunks.length;
    if (nextCount > MAX_LIVE_STROKE_CHUNKS) {
      throw new RangeError("A live stroke cannot contain more than 512 finalized chunks.");
    }
    if (nextCount < this.#chunkNodes.length) {
      throw new Error("Finalized live-stroke chunks cannot be removed without clearing.");
    }
    if (
      this.#lastChunk !== undefined &&
      preview.finalizedChunks[this.#chunkNodes.length - 1] !== this.#lastChunk
    ) {
      throw new Error("Finalized live-stroke chunks must retain immutable prefix identity.");
    }
  }

  private validateEntrants(preview: SceneLiveStrokePreview): void {
    this.validateParts(preview.tail.geometry);
    for (let index = this.#chunkNodes.length; index < preview.finalizedChunks.length; index += 1) {
      this.validateParts(preview.finalizedChunks[index]!.geometry);
    }
  }

  private validateParts(parts: readonly SvgPathPart[]): void {
    if (parts.length === 0 || parts.length > MAX_LIVE_PATH_PARTS) {
      throw new RangeError("Live strokes require exactly one path part.");
    }
    const paint = this.#style?.pressureEnabled === true ? "fill" : "stroke";
    if (parts.some((part) => part.paint !== paint)) {
      throw new TypeError(`Live stroke paint must be ${paint}.`);
    }
  }

  private updateTail(parts: readonly SvgPathPart[]): void {
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      const node = this.#tailNodes[index];
      if (node === undefined) {
        const created = this.createPath(part);
        this.#tailNodes.push(created);
        this.#group.append(created);
        this.#instrumentation.liveTailNodesCreated += 1;
      } else {
        this.updateTailAttribute(node, "d", part.d);
      }
    }
    for (let index = parts.length; index < this.#tailNodes.length; index += 1) {
      this.updateTailAttribute(this.#tailNodes[index]!, "d", "");
    }
  }

  private updateTailAttribute(node: SVGPathElement, name: string, value: string): void {
    if (node.getAttribute(name) === value) return;
    node.setAttribute(name, value);
    this.#instrumentation.attributeWrites += 1;
  }

  private removeAllNodes(): void {
    for (const node of this.#tailNodes) node.remove();
    this.#instrumentation.liveTailNodesRemoved += this.#tailNodes.length;
    this.#tailNodes = [];
    for (const nodes of this.#chunkNodes) {
      for (const node of nodes) node.remove();
      this.#instrumentation.liveChunkNodesRemoved += nodes.length;
    }
    this.#chunkNodes.length = 0;
    this.#chunkPathCount = 0;
  }

  private resetStrokeState(): void {
    if (this.#style !== undefined) {
      this.#group.removeAttribute("opacity");
      this.#instrumentation.attributeWrites += 1;
    }
    this.#lastChunk = undefined;
    this.#lastTail = undefined;
    this.#presentation = undefined;
    this.#style = undefined;
    this.#tool = undefined;
    this.#placeGroup("content");
  }

  private assertActive(): void {
    if (this.#disposed) throw new Error("The live stroke renderer has been disposed.");
  }
}

function sameStrokeStyle(left: StrokeStyleV1, right: StrokeStyleV1): boolean {
  return (
    left.width === right.width &&
    left.opacity === right.opacity &&
    left.pressureEnabled === right.pressureEnabled &&
    left.smoothing === right.smoothing &&
    left.color.type === right.color.type &&
    (left.color.type === "theme-text" ||
      (right.color.type === "rgba" && left.color.value === right.color.value))
  );
}

function withoutPerPathOpacity(presentation: PathPresentation): PathPresentation {
  return {
    ...presentation,
    "fill-opacity": null,
    "stroke-opacity": null,
  };
}
