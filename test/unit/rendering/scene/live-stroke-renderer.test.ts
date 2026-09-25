import { describe, expect, it } from "vitest";

import { MAX_STROKE_POINTS, type StrokeStyleV1 } from "../../../../src/domain/schema/public";
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
  return Object.freeze({ geometry: [{ d, paint }] });
}

function preview(
  finalizedChunks: readonly SceneLiveStrokeChunk[],
  tailD: string,
  paint: "fill" | "stroke",
): SceneLiveStrokePreview {
  return { finalizedChunks, tail: Object.freeze({ geometry: [{ d: tailD, paint }] }) };
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
  return { document, group: group.nodes[0]!, instrumentation, renderer };
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
    expect(group.nodes).toHaveLength(2);
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

  it.each(["pen", "highlighter"] as const)(
    "composites %s color alpha once across live chunks and handoff",
    (tool) => {
      const { document, group, renderer } = setupRenderer();
      const style: StrokeStyleV1 = {
        ...(tool === "pen" ? penStyle : highlighterStyle),
        color: { type: "rgba", value: "#12345680" },
      };
      const paint = tool === "pen" ? "fill" : "stroke";
      renderer.update(preview([chunk("M0 0L2 2Z", paint)], "M1 1L3 3Z", paint), style, tool);
      const alpha = (style.opacity * 128) / 255;
      const opacity = String(style.pressureEnabled ? Math.round(alpha * 10000) / 10000 : alpha);
      expect(group.attributes.get("opacity")).toBe(opacity);
      for (const path of group.nodes) {
        expect(path.attributes.get(paint)).toBe("#123456FF");
        expect(path.attributes.has(`${paint}-opacity`)).toBe(false);
      }
      const parent = new FakeNode(document, "g");
      renderer.commit("alpha", () => parent as unknown as SVGGElement);
      expect(parent.nodes[0]!.attributes.get("opacity")).toBe(opacity);
      renderer.dispose();
    },
  );

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

  it("updates the continuous pressure tail immediately without changing finalized geometry", () => {
    const { group, instrumentation, renderer } = setupRenderer();
    const geometry = [{ d: "M0 0L1 2L2 0Z", paint: "fill" as const }];
    const immutable = Object.freeze({ geometry });
    renderer.update({ finalizedChunks: [immutable], tail: { geometry } }, penStyle, "pen");
    const prefix = group.nodes[0]!;
    const prefixPaint = new Map(prefix.attributes);
    const tail = group.nodes[1]!;
    for (let frame = 0; frame < 40; frame += 1) {
      const parts = [{ ...geometry[0]!, d: `M${frame} 0L${frame + 1} 2L${frame + 2} 0Z` }];
      renderer.update({ finalizedChunks: [immutable], tail: { geometry: parts } }, penStyle, "pen");
      expect(group.nodes).toEqual([prefix, tail]);
      expect(prefix.attributes).toEqual(prefixPaint);
      expect(tail.attributes.get("d")).toBe(parts[0]!.d);
      expect(tail.attributes.has("fill-opacity")).toBe(false);
    }
    expect(instrumentation.liveMaximumTailNodes).toBe(1);
    expect(instrumentation.liveTailNodesCreated).toBe(1);
    expect(group.attributes.get("opacity")).toBe("0.7");
    renderer.dispose();
  });
});

describe("live stroke capacity validation", () => {
  it("retains the full-capacity prefix and opacity through overflow rejection and handoff", () => {
    const { document, group, instrumentation, renderer } = setupRenderer();
    const chunks = Array.from({ length: Math.ceil(MAX_STROKE_POINTS / 64) }, (_, index) =>
      chunk(`M${index} 0L${index + 1} 1Z`, "fill"),
    );
    renderer.update(preview(chunks.slice(0, 128), "M128 0Z", "fill"), penStyle, "pen");
    const prefix = group.nodes.slice(0, 128);
    const tail = group.nodes[128];
    renderer.update(preview(chunks, "M16384 0Z", "fill"), penStyle, "pen");
    expect(group.nodes.slice(0, 128)).toEqual(prefix);
    expect(group.nodes[group.nodes.length - 1]).toBe(tail);
    expect(group.nodes).toHaveLength(chunks.length + 1);
    const accepted = [...group.nodes];
    const writes = instrumentation.attributeWrites;
    expect(() =>
      renderer.update(
        preview([...chunks, chunk("M16385 0Z", "fill")], "M16385 0Z", "fill"),
        penStyle,
        "pen",
      ),
    ).toThrow("finalized chunks");
    expect(instrumentation.attributeWrites).toBe(writes);
    expect(group.nodes).toEqual(accepted);
    expect(tail?.attributes.get("d")).toBe("M16384 0Z");
    const parent = new FakeNode(document, "g");
    renderer.commit("maximum", () => parent as unknown as SVGGElement);
    expect(parent.nodes[0]).toBe(group);
    expect(group.attributes.get("opacity")).toBe("0.7");
    expect(group.nodes).toEqual(accepted);
    renderer.dispose();
    expect(instrumentation.liveChunkNodesRemoved).toBe(chunks.length);
    expect(instrumentation.liveTailNodesRemoved).toBe(1);
  });

  it("rejects empty, oversized, and inconsistent path batches", () => {
    const { renderer } = setupRenderer();
    const part = { d: "M0 0L1 1", paint: "fill" as const };
    for (const geometry of [[], Array.from({ length: 2 }, () => part)]) {
      expect(() =>
        renderer.update({ finalizedChunks: [], tail: { geometry } }, penStyle, "pen"),
      ).toThrow("exactly one");
    }
    expect(() =>
      renderer.update(
        {
          finalizedChunks: Array.from({ length: Math.ceil(MAX_STROKE_POINTS / 64) + 1 }, () =>
            chunk("M0 0", "stroke"),
          ),
          tail: { geometry: [part] },
        },
        penStyle,
        "pen",
      ),
    ).toThrow("finalized chunks");
    renderer.dispose();
  });
});

describe("live stroke prefix validation", () => {
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
