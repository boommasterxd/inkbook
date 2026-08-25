import type { StrokeElementV1, StrokeStyleV1 } from "../../domain/schema/public";
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

const MAX_LIVE_STROKE_CHUNKS = 4096;

export class SceneLiveStrokeRenderer {
  readonly #chunkNodes: SVGPathElement[] = [];
  #disposed = false;
  readonly #group: SVGGElement;
  readonly #placeGroup: (band: "content" | "highlight") => void;
  readonly #instrumentation: MutableSceneInstrumentation;
  #lastChunk: SceneLiveStrokeChunk | undefined;
  #lastTail: SceneLiveStrokePreview["tail"] | undefined;
  readonly #ownerDocument: Document;
  #presentation: PathPresentation | undefined;
  #style: StrokeStyleV1 | undefined;
  #tailNode: SVGPathElement | undefined;
  #tool: StrokeElementV1["tool"] | undefined;

  public constructor(
    ownerDocument: Document,
    group: SVGGElement,
    placeGroup: (band: "content" | "highlight") => void,
    instrumentation: MutableSceneInstrumentation,
  ) {
    this.#ownerDocument = ownerDocument;
    this.#group = group;
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
    this.ensurePresentation(style, preview.tail.geometry.paint, tool);
    this.#placeGroup(tool === "highlighter" ? "highlight" : "content");
    if (
      preview.finalizedChunks.length === this.#chunkNodes.length &&
      preview.tail === this.#lastTail
    ) {
      return;
    }
    this.validateEntrants(preview);
    this.appendChunks(preview);
    this.updateTail(preview.tail.geometry.d);
    this.#lastTail = preview.tail;
    this.#instrumentation.livePreviewUpdates += 1;
    this.#instrumentation.liveMaximumTailNodes = 1;
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
    this.#disposed = true;
  }

  private appendChunks(preview: SceneLiveStrokePreview): void {
    for (let index = this.#chunkNodes.length; index < preview.finalizedChunks.length; index += 1) {
      const chunk = preview.finalizedChunks[index];
      if (chunk === undefined) continue;
      const node = this.createPath(chunk.geometry.d);
      this.#group.insertBefore(node, this.#tailNode ?? null);
      this.#chunkNodes.push(node);
      this.#lastChunk = chunk;
      this.#instrumentation.liveChunkNodesCreated += 1;
    }
    this.#instrumentation.liveMaximumChunkNodes = Math.max(
      this.#instrumentation.liveMaximumChunkNodes,
      this.#chunkNodes.length,
    );
  }

  private createPath(d: string): SVGPathElement {
    const node = this.#ownerDocument.createElementNS(SVG_NAMESPACE, "path");
    node.setAttribute("d", d);
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

  private ensurePresentation(
    style: StrokeStyleV1,
    paint: "fill" | "stroke",
    tool: StrokeElementV1["tool"],
  ): void {
    const expectedPaint = style.pressureEnabled ? "fill" : "stroke";
    if (paint !== expectedPaint) {
      throw new TypeError(`Live stroke paint must be ${expectedPaint}.`);
    }
    if (this.#style !== undefined) {
      if (this.#tool !== tool || !sameStrokeStyle(this.#style, style)) {
        throw new Error("A live stroke cannot change paint after rendering starts.");
      }
      return;
    }
    this.#style = style;
    this.#tool = tool;
    this.#group.setAttribute("opacity", String(style.opacity));
    this.#instrumentation.attributeWrites += 1;
    this.#presentation = withoutPerPathOpacity(liveStrokePresentation(style, paint, tool));
  }

  private assertAppendOnly(preview: SceneLiveStrokePreview): void {
    const nextCount = preview.finalizedChunks.length;
    if (nextCount > MAX_LIVE_STROKE_CHUNKS) {
      throw new RangeError("A live stroke cannot contain more than 4096 finalized chunks.");
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
    const expectedPaint = this.#style?.pressureEnabled === false ? "stroke" : "fill";
    for (let index = this.#chunkNodes.length; index < preview.finalizedChunks.length; index += 1) {
      if (preview.finalizedChunks[index]?.geometry.paint !== expectedPaint) {
        throw new TypeError(`Live stroke paint must be ${expectedPaint}.`);
      }
    }
  }

  private removeTail(): void {
    if (this.#tailNode === undefined) return;
    this.#tailNode.remove();
    this.#tailNode = undefined;
    this.#instrumentation.liveTailNodesRemoved += 1;
  }

  private updateTail(d: string): void {
    if (this.#tailNode === undefined) {
      this.#tailNode = this.createPath(d);
      this.#group.append(this.#tailNode);
      this.#instrumentation.liveTailNodesCreated += 1;
      return;
    }
    if (this.#tailNode.getAttribute("d") === d) return;
    this.#tailNode.setAttribute("d", d);
    this.#instrumentation.attributeWrites += 1;
  }

  private removeAllNodes(): void {
    this.removeTail();
    for (const node of this.#chunkNodes) node.remove();
    this.#instrumentation.liveChunkNodesRemoved += this.#chunkNodes.length;
    this.#chunkNodes.length = 0;
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
