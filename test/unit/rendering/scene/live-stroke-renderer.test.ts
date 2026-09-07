import { describe, expect, it } from "vitest";

import type { StrokeStyleV1 } from "../../../../src/domain/schema/public";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { SceneLiveStrokeRenderer } from "../../../../src/rendering/scene/live-stroke-renderer";
import type {
  SceneLiveStrokeChunk,
  SceneLiveStrokePreview,
} from "../../../../src/rendering/scene/types";

import { FakeDocument, FakeNode } from "./fakes";

const penStyle: StrokeStyleV1 = {
  color: { type: "theme-text" },
  opacity: 0.7,
  pressureEnabled: true,
  smoothing: 0.5,
  width: 8,
};

const highlighterStyle: StrokeStyleV1 = {
  color: { type: "rgba", value: "#EAB308FF" },
  opacity: 0.4,
  pressureEnabled: false,
  smoothing: 0.5,
  width: 8,
};

function chunk(d: string, paint: "fill" | "stroke"): SceneLiveStrokeChunk {
  return Object.freeze({ geometry: { d, paint } });
}

function preview(
  finalizedChunks: readonly SceneLiveStrokeChunk[],
  tailD: string,
  paint: "fill" | "stroke",
): SceneLiveStrokePreview {
  return { finalizedChunks, tail: Object.freeze({ geometry: { d: tailD, paint } }) };
}

function setupRenderer(): {
  document: FakeDocument;
  group: FakeNode;
  instrumentation: ReturnType<typeof createInstrumentation>;
  renderer: SceneLiveStrokeRenderer;
} {
  const document = new FakeDocument();
  const group = new FakeNode(document, "g");
  const instrumentation = createInstrumentation();
  const renderer = new SceneLiveStrokeRenderer(
    document as unknown as Document,
    group as unknown as SVGGElement,
    () => undefined,
    instrumentation,
  );
  return { document, group, instrumentation, renderer };
}

describe("incremental live stroke renderer", () => {
  it("transfers chunk identity and group opacity while isolating the next gesture", () => {
    const { document, group, instrumentation, renderer } = setupRenderer();
    const parent = new FakeNode(document, "g");
    const target = () => parent as unknown as SVGGElement;
    renderer.commit("empty", target);
    expect(parent.nodes).toHaveLength(0);
    renderer.update(preview([chunk("M 0 0 Z", "fill")], "M 1 1 Z", "fill"), penStyle, "pen");
    const chunkNode = group.nodes[0];
    const tailNode = group.nodes[1];
    renderer.commit("first", target);
    const retained = parent.nodes[0]!;
    expect(retained.nodes).toEqual([chunkNode, tailNode]);
    expect(retained.attributes.get("opacity")).toBe("0.7");
    expect(group.nodes).toHaveLength(0);
    renderer.update(preview([], "M 2 2", "stroke"), highlighterStyle, "highlighter");
    expect(() => renderer.commit("first", target)).toThrow("unique");
    renderer.clear();
    renderer.settleCommits(() => false);
    expect(retained.parent).toBe(parent);
    renderer.settleCommits(() => true);
    expect(retained.parent).toBeUndefined();
    expect(instrumentation.liveChunkNodesRemoved).toBe(1);
    expect(instrumentation.liveTailNodesRemoved).toBe(2);
    renderer.dispose();
    expect(() => renderer.commit("disposed", target)).toThrow("disposed");
  });

  it("retains finalized chunk nodes and updates one bounded tail node", () => {
    const { document, group, instrumentation, renderer } = setupRenderer();
    const firstChunk = chunk("M 0 0 Z", "fill");

    renderer.update(preview([], "M 0 0 Z", "fill"), penStyle, "pen");
    const firstTail = group.nodes[0];
    renderer.update(preview([firstChunk], "M 1 1 Z", "fill"), penStyle, "pen");
    const stableChunkNode = group.nodes[0];
    const secondTail = group.nodes[1];
    renderer.update(preview([firstChunk], "M 2 2 Z", "fill"), { ...penStyle }, "pen");

    expect(group.nodes).toHaveLength(2);
    expect(group.nodes[0]).toBe(stableChunkNode);
    expect(group.nodes[1]).toBe(secondTail);
    expect(group.nodes[1]).toBe(firstTail);
    expect(firstTail?.parent).toBe(group);
    expect(firstTail?.attributes.get("d")).toBe("M 2 2 Z");
    expect(stableChunkNode?.ownerDocument).toBe(document);
    expect(Object.fromEntries(stableChunkNode?.attributes ?? [])).toMatchObject({
      class: "inkbook-theme-fill",
      fill: "#222222FF",
      "fill-rule": "nonzero",
      stroke: "none",
    });
    expect(stableChunkNode?.attributes.has("fill-opacity")).toBe(false);
    expect(group.attributes.get("opacity")).toBe("0.7");
    expect(instrumentation).toMatchObject({
      contentAttributeWrites: 0,
      contentGeometryWrites: 0,
      liveChunkNodesCreated: 1,
      liveMaximumChunkNodes: 1,
      liveMaximumTailNodes: 1,
      livePreviewUpdates: 3,
      liveTailNodesCreated: 1,
      liveTailNodesRemoved: 0,
    });

    renderer.clear();
    expect(group.nodes).toHaveLength(0);
    expect(group.attributes.has("opacity")).toBe(false);
    expect(instrumentation).toMatchObject({
      liveChunkNodesRemoved: 1,
      liveTailNodesRemoved: 1,
    });
  });
});

describe("live stroke lifecycle and validation", () => {
  it("uses the selected base width for a pressure-disabled pen", () => {
    const { group, renderer } = setupRenderer();
    const pressureDisabledPenStyle: StrokeStyleV1 = { ...penStyle, pressureEnabled: false };

    renderer.update(preview([], "M 0 0 L 10 10", "stroke"), pressureDisabledPenStyle, "pen");

    expect(group.nodes[0]?.attributes.get("stroke-width")).toBe("8");
  });

  it("matches committed highlighter paint and applies the 2.5x base width", () => {
    const { group, renderer } = setupRenderer();
    const strokePreview = preview([], "M 0 0 L 10 10", "stroke");

    renderer.update(strokePreview, highlighterStyle, "highlighter");
    expect(Object.fromEntries(group.nodes[0]?.attributes ?? [])).toMatchObject({
      fill: "none",
      stroke: "#EAB308FF",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "stroke-width": "20",
    });
    expect(group.nodes[0]?.attributes.has("stroke-opacity")).toBe(false);
    expect(group.attributes.get("opacity")).toBe("0.4");
    renderer.revert();
    expect(group.nodes).toHaveLength(0);
    expect(group.attributes.has("opacity")).toBe(false);

    renderer.update(strokePreview, highlighterStyle, "highlighter");
    renderer.dispose();
    expect(group.nodes).toHaveLength(0);
    expect(() => renderer.update(strokePreview, highlighterStyle, "highlighter")).toThrow(
      /disposed/,
    );
  });

  it("rejects changed finalized prefixes and inconsistent paint", () => {
    const { renderer } = setupRenderer();
    const firstChunk = chunk("M 0 0 Z", "fill");
    renderer.update(preview([firstChunk], "M 1 1 Z", "fill"), penStyle, "pen");

    expect(() =>
      renderer.update(preview([chunk("M 0 0 Z", "fill")], "M 2 2 Z", "fill"), penStyle, "pen"),
    ).toThrow(/immutable prefix identity/);
    expect(() =>
      renderer.update(preview([firstChunk], "M 2 2", "stroke"), penStyle, "pen"),
    ).toThrow(/must be fill/);
  });
});
