import { describe, expect, it, vi } from "vitest";
import { cursorPointerEvent, toolCursorHarness } from "../../../fixtures/obsidian/tool-cursor";
import { sceneNavigationFixture } from "../../../fixtures/obsidian/scene-navigation";
import { createInputState } from "../../../../src/editor/input";
import type { StrokeStyleV1 } from "../../../../src/domain/schema/public";
import { liveStrokePresentation } from "../../../../src/rendering/scene/element-presentation";
import { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { SVG_NAMESPACE } from "../../../../src/rendering/scene/constants";
import type { SceneToolCursor } from "../../../../src/rendering/scene/tool-cursor";
import {
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  FakeScheduler,
  asElement,
  fakeNode,
  fakeRectangleRecord,
} from "../../../unit/rendering/scene/fakes";

const CURSOR: Extract<SceneToolCursor, { kind: "tool" }> = {
  color: { type: "rgba", value: "#FFCC0080" },
  kind: "tool",
  opacity: 0.4,
  icon: new FakeDocument().createElementNS(SVG_NAMESPACE, "svg") as unknown as SVGSVGElement,
  x: 20,
  y: 30,
};
const FRAME = { cursor: CURSOR, system: "crosshair" };
const STYLE: StrokeStyleV1 = {
  color: CURSOR.color,
  opacity: 0.4,
  width: 8,
  smoothing: 0.5,
  pressureEnabled: false,
};
function setup() {
  const document = new FakeDocument();
  const container = new FakeNode(document, "div");
  const scheduler = new FakeScheduler();
  const store = new FakeSceneStore();
  const layout = { readViewport: vi.fn(() => ({ height: 100, left: 0, top: 0, width: 100 })) };
  const renderer = new SvgSceneRenderer({
    container: asElement(container),
    layout,
    page: {
      activeBufferLines: 3,
      background: { type: "none" },
      innerWidth: 2000,
      lockedBufferLines: 1,
      margin: 24.3,
    },
    workScheduler: scheduler.workScheduler,
    store,
  });
  scheduler.runAll();
  const svg = fakeNode(renderer.svg);
  const cursor = document.body.nodes[0]!.nodes[0]!;
  return { renderer, scheduler, store, layout, cursor, svg };
}

describe("retained tool cursor", () => {
  it("keeps the icon at the stationary pointer before the scene frame on zoom, pan and resize", () => {
    const { renderer, scheduler, cursor, read, navigation, top, owner, navigationFrame, binding } =
      sceneNavigationFixture(setup(), CURSOR);
    const assertPosition = () => {
      expect(cursor.attributes.get("transform")).toBe(`translate(250 ${String(300 - top())})`);
      expect(read).toHaveBeenCalledExactlyOnceWith(true);
      scheduler.runAll();
      expect(read).toHaveBeenCalledTimes(1);
    };
    for (const deltaY of [-100, -100, 100]) {
      read.mockClear();
      read.layout.readViewport.mockClear();
      navigation.updateWheel({ clientX: 250, clientY: 300, deltaMode: 0, deltaY });
      navigationFrame();
      assertPosition();
      expect(read.layout.readViewport).not.toHaveBeenCalled();
    }
    read.mockClear();
    navigation.scroll(30);
    navigationFrame();
    assertPosition();
    read.mockClear();
    navigation.applyResize({ cameraX: 0, fitZoom: 0.1, zoom: 1, scrollTop: 275 });
    assertPosition();
    read.mockClear();
    owner.scrollTop = 250;
    for (let sample = 0; sample < 10; sample += 1) owner.dispatchEvent(new Event("scroll"));
    expect(read).not.toHaveBeenCalled();
    scheduler.runAll();
    expect(cursor.attributes.get("transform")).toBe("translate(250 250)");
    expect(read).toHaveBeenCalledTimes(1);
    binding.dispose();
    navigation.dispose();
    renderer.destroy();
  });
  it("coalesces input, writes only changed attributes and leaves content and layout untouched", () => {
    const { renderer, scheduler, store, layout, cursor, svg } = setup();
    const reads = vi.spyOn(store, "get");
    const queries = vi.spyOn(store, "query");
    const writes = vi.spyOn(cursor, "setAttribute");
    layout.readViewport.mockClear();
    const obsoleteRead = vi.fn(() => FRAME);
    renderer.requestToolCursorFrame(obsoleteRead);
    renderer.requestToolCursorFrame(() => ({ ...FRAME, cursor: { ...CURSOR, x: 40 } }));
    expect(cursor.attributes.get("display")).toBe("none");
    expect(scheduler.pendingCount).toBe(1);
    scheduler.runAll();
    expect(obsoleteRead).not.toHaveBeenCalled();
    expect(cursor.parent?.parent).toBe(svg.ownerDocument.body);
    expect(cursor.nodes.map((node) => node.tagName)).toEqual(["circle", "g"]);
    expect(cursor.attributes.get("transform")).toBe("translate(40 30)");
    expect(cursor.nodes[1]!.attributes.get("color")).toBe("#FFCC0080");
    expect(cursor.nodes[1]!.nodes[0]).toBe(fakeNode(CURSOR.icon!));
    writes.mockClear();
    renderer.requestToolCursorFrame(() => ({ ...FRAME, cursor: { ...CURSOR, x: 40 } }));
    scheduler.runAll();
    expect(writes).not.toHaveBeenCalled();
    renderer.requestToolCursorFrame(() => ({ cursor: { ...CURSOR, x: 41 }, system: "crosshair" }));
    scheduler.runAll();
    expect(writes.mock.calls).toEqual([["transform", "translate(41 30)"]]);
    expect(reads).not.toHaveBeenCalled();
    expect(queries).not.toHaveBeenCalled();
    expect(layout.readViewport).not.toHaveBeenCalled();
    renderer.destroy();
  });

  it("keeps one exact eraser ring, theme paint and node identity across zoom and hide", () => {
    const { renderer, scheduler, cursor, svg } = setup();
    renderer.requestToolCursorFrame(() => ({
      ...FRAME,
      cursor: { ...CURSOR, kind: "eraser", radius: 64 },
    }));
    scheduler.runAll();
    renderer.setCamera({ x: 15, zoom: 4 });
    scheduler.runAll();
    const ring = cursor.nodes[0]!;
    expect(ring.attributes.get("r")).toBe("64");
    expect(ring.attributes.get("fill")).toBe("none");
    expect(ring.attributes.get("stroke")).toBe("var(--inkbook-text)");
    expect(ring.attributes.get("stroke-dasharray")).toBe("4 3");
    expect(cursor.nodes[1]!.attributes.get("visibility")).toBe("hidden");
    renderer.requestToolCursorFrame(() => ({ cursor: null, system: "crosshair" }));
    scheduler.runAll();
    renderer.requestToolCursorFrame(() => ({
      ...FRAME,
      cursor: { ...CURSOR, color: { type: "theme-text" } },
    }));
    scheduler.runAll();
    expect(cursor.parent?.parent).toBe(svg.ownerDocument.body);
    expect(cursor.nodes[1]!.attributes.get("color")).toBe("var(--inkbook-text)");
    expect(ring.attributes.get("visibility")).toBe("hidden");
    renderer.requestToolCursorFrame(() => ({ cursor: null, system: "crosshair" }));
    renderer.destroy();
    expect(scheduler.pendingCount).toBe(0);
    expect(() => renderer.requestToolCursorFrame(() => FRAME)).toThrow("destroyed");
  });
});

describe("persistent tool decoration and frame reads", () => {
  it("keeps the offset icon visible during incremental ink and commit", () => {
    const { renderer, scheduler, cursor, svg } = setup();
    renderer.requestToolCursorFrame(() => FRAME);
    scheduler.runAll();
    renderer.updateLiveStroke(
      { finalizedChunks: [], tail: { geometry: [{ d: "", paint: "stroke" }] } },
      STYLE,
      "pen",
    );
    expect(cursor.attributes.get("display")).toBe("inline");
    renderer.updateLiveStroke(
      { finalizedChunks: [], tail: { geometry: [{ d: "M20 30L21 30", paint: "stroke" }] } },
      STYLE,
      "pen",
    );
    expect(cursor.attributes.get("display")).toBe("inline");
    expect(svg.nodes[1]!.nodes[6]!.nodes[0]!.nodes[0]!.attributes.get("d")).toBe("M20 30L21 30");
    renderer.commitLiveStroke("new");
    scheduler.runAll();
    expect(cursor.attributes.get("display")).toBe("inline");
    renderer.destroy();
  });

  it("keeps the offset icon visible throughout staged straight-marker painting", () => {
    const { renderer, scheduler, cursor, svg } = setup();
    renderer.requestToolCursorFrame(() => FRAME);
    scheduler.runAll();
    renderer.setLivePath({
      parts: [
        { d: "M20 30L50 30", presentation: liveStrokePresentation(STYLE, "stroke", "highlighter") },
      ],
    });
    expect(cursor.attributes.get("display")).toBe("inline");
    const path = svg.nodes[1]!.nodes[5]!.nodes[0]!;
    expect(path.attributes.get("d") ?? "").toBe("");
    scheduler.runAll();
    expect(path.attributes.get("d")).toBe("M20 30L50 30");
    expect(cursor.attributes.get("display")).toBe("inline");
    renderer.setLivePath(null);
    scheduler.runAll();
    expect(cursor.attributes.get("display")).toBe("inline");
    renderer.destroy();
  });

  it("reads latest frame state once and invalidates layout explicitly", () => {
    const { renderer, scheduler, cursor } = setup();
    const reader = vi.fn(() => FRAME);
    renderer.requestToolCursorFrame(reader);
    renderer.requestToolCursorFrame(reader);
    scheduler.runAll();
    expect(reader.mock.calls).toEqual([[true]]);
    expect(fakeNode(renderer.inputSurface).style.cursor).toBe("crosshair");
    renderer.requestToolCursorFrame(reader);
    scheduler.runAll();
    expect(reader.mock.calls[reader.mock.calls.length - 1]).toEqual([false]);
    expect(cursor.attributes.get("display")).toBe("inline");
    renderer.invalidateLayout();
    scheduler.runAll();
    expect(reader.mock.calls[reader.mock.calls.length - 1]).toEqual([true]);
    renderer.setViewport({ height: 100, width: 90, top: 0, left: 0 });
    scheduler.runAll();
    expect(reader.mock.calls[reader.mock.calls.length - 1]).toEqual([true]);
    renderer.setCamera({ x: 10, zoom: 2 });
    scheduler.runAll();
    expect(reader.mock.calls[reader.mock.calls.length - 1]).toEqual([true]);
    renderer.destroy();
  });
});

describe("tool decoration swaps", () => {
  it("paints nested toolbar geometry with independent fill and outline alpha without rebuilding", () => {
    const { renderer, scheduler, cursor } = setup();
    const icon = new FakeNode(new FakeDocument(), "svg");
    const nested = new FakeNode(icon.ownerDocument, "svg");
    nested.setAttribute("fill", "none");
    const shape = new FakeNode(icon.ownerDocument, "rect");
    nested.append(shape);
    icon.append(nested);
    const state: Extract<SceneToolCursor, { kind: "tool" }> = {
      ...CURSOR,
      icon: icon as unknown as SVGSVGElement,
      fillColor: { type: "rgba", value: "#12345680" },
      fillOpacity: 0.6,
    };
    renderer.requestToolCursorFrame(() => ({ cursor: state, system: "crosshair" }));
    scheduler.runAll();
    const host = cursor.nodes[1]!;
    expect(host.attributes.get("opacity")).toBe("1");
    expect(host.attributes.get("stroke-opacity")).toBe("0.4");
    expect(host.attributes.get("color")).toBe("#FFCC0080");
    expect(shape.attributes.get("fill")).toBe("#12345680");
    expect(shape.attributes.get("fill-opacity")).toBe("0.6");
    const append = vi.spyOn(host, "append");
    const writes = vi.spyOn(shape, "setAttribute");
    renderer.requestToolCursorFrame(() => ({ cursor: { ...state, x: 23 }, system: "crosshair" }));
    scheduler.runAll();
    expect(writes).not.toHaveBeenCalled();
    renderer.requestToolCursorFrame(() => ({
      ...FRAME,
      cursor: { ...state, fillColor: null, fillOpacity: 0.2, opacity: 0.7 },
    }));
    scheduler.runAll();
    expect(writes.mock.calls).toEqual([
      ["fill", "none"],
      ["fill-opacity", "0.2"],
    ]);
    expect(host.attributes.get("stroke-opacity")).toBe("0.7");
    expect(append).not.toHaveBeenCalled();
    renderer.requestToolCursorFrame(() => FRAME);
    scheduler.runAll();
    expect(host.attributes.get("opacity")).toBe("0.4");
    expect(host.attributes.get("stroke-opacity")).toBe("1");
    renderer.destroy();
  });

  it("reuses a stable icon, swaps only changed identities and permits missing icons", () => {
    const { renderer, scheduler, cursor } = setup();
    const iconHost = cursor.nodes[1]!;
    const append = vi.spyOn(iconHost, "append");
    renderer.requestToolCursorFrame(() => FRAME);
    scheduler.runAll();
    renderer.requestToolCursorFrame(() => ({ cursor: { ...CURSOR, x: 44 }, system: "crosshair" }));
    scheduler.runAll();
    expect(append).toHaveBeenCalledTimes(1);
    const icon = new FakeDocument().createElementNS(
      SVG_NAMESPACE,
      "svg",
    ) as unknown as SVGSVGElement;
    renderer.requestToolCursorFrame(() => ({ cursor: { ...CURSOR, icon }, system: "crosshair" }));
    scheduler.runAll();
    expect(append).toHaveBeenCalledTimes(2);
    expect(iconHost.nodes).toEqual([fakeNode(icon)]);
    renderer.requestToolCursorFrame(() => ({ ...FRAME, cursor: { ...CURSOR, icon: undefined } }));
    scheduler.runAll();
    expect(iconHost.nodes).toHaveLength(0);
    expect(cursor.attributes.get("display")).toBe("inline");
    renderer.requestToolCursorFrame(() => ({ cursor: { ...CURSOR, icon }, system: "crosshair" }));
    scheduler.runAll();
    renderer.destroy();
    expect(iconHost.nodes).toHaveLength(0);
    expect(fakeNode(icon).parent).toBeUndefined();
  });
});

describe("retained staged marker commits", () => {
  it("retains two fast commits until each mounts, including partial reconciliation", () => {
    const { renderer, scheduler, cursor, store, svg } = setup();
    const group = svg.nodes[1]!.nodes[4]!;
    renderer.requestToolCursorFrame(() => FRAME);
    scheduler.runAll();
    const ids = ["first", "second"];
    for (const [rank, id] of ids.entries()) {
      const record = fakeRectangleRecord(id, rank, 10);
      store.records.set(id, record);
      renderer.applyDelta({
        affected: [{ after: record.element, before: null, domains: ["visibility"], id }],
      });
      renderer.setLivePath({
        parts: [
          {
            d: `M10 10L${String(20 + rank)} 10`,
            presentation: liveStrokePresentation(STYLE, "stroke", "highlighter"),
          },
        ],
      });
      renderer.commitLivePath(id);
    }
    expect(cursor.attributes.get("display")).toBe("inline");
    expect(group.nodes).toHaveLength(2);
    const retained = [...group.nodes];
    expect(retained.map((node) => node.nodes[0]!.attributes.get("d"))).toEqual([
      "M10 10L20 10",
      "M10 10L21 10",
    ]);
    const clock = vi.spyOn(scheduler, "now").mockImplementation(() => {
      scheduler.time += 2;
      return scheduler.time;
    });
    let preparationFrames = 0;
    while (renderer.mountedCount === 0) {
      // Match FakeScheduler.runAll's liveness guard without requiring a specific frame count.
      if (++preparationFrames > 100)
        throw new Error("Marker handoff publication failed to settle.");
      expect(scheduler.pendingCount).toBe(1);
      scheduler.runNext();
      const mounted = new Set(renderer.mountedIds("content"));
      retained.forEach((node, index) => {
        expect(node.parent === group).toBe(!mounted.has(ids[index]!));
        expect(node.nodes[0]!.attributes.get("d")).toBe(`M10 10L${String(20 + index)} 10`);
      });
    }
    expect(renderer.mountedCount).toBe(1);
    expect(retained.filter((node) => node.parent === group)).toHaveLength(1);
    clock.mockRestore();
    scheduler.runAll();
    expect(retained.every((node) => node.parent === undefined)).toBe(true);
    expect(renderer.mountedIds("content")).toEqual(ids);
    expect(group.nodes).toHaveLength(2);
    renderer.destroy();
  });

  it("releases obsolete handoffs on removal, preserves identity and cleans up on disposal", () => {
    const { renderer, scheduler, store, svg } = setup();
    const record = fakeRectangleRecord("removed", 0, 10);
    store.records.set(record.id, record);
    renderer.setLivePath({
      parts: [
        { d: "M10 10L20 10", presentation: liveStrokePresentation(STYLE, "stroke", "highlighter") },
      ],
    });
    renderer.commitLivePath(record.id);
    const retained = svg.nodes[1]!.nodes[4]!.nodes[0]!;
    expect(() => renderer.commitLivePath(record.id)).toThrow("unique");
    store.records.delete(record.id);
    renderer.applyDelta({
      affected: [{ after: null, before: record.element, domains: ["visibility"], id: record.id }],
    });
    expect(retained.parent).toBeUndefined();
    scheduler.runAll();
    renderer.destroy();
    expect(() => renderer.commitLivePath("late")).toThrow("destroyed");
  });
});

it.each([
  ["mouse", "eraser", "mouse"],
  ["pen", "eraser", "pen"],
  ["pen", "draw", "pen"],
  ["pen", "eraser", "mouse"],
  ["pen", "draw", "mouse"],
] as const)(
  "removes the entire %s %s decoration on %s hover departure",
  (pointerType, activeTool, departureType) => {
    const { renderer, scheduler, cursor } = setup();
    const h = toolCursorHarness();
    h.controls.input = createInputState({ activeTool });
    h.icon.mockReturnValue(CURSOR.icon!);
    const flush = () => {
      renderer.requestToolCursorFrame(() => h.read());
      scheduler.runAll();
    };
    h.surface.dispatchEvent(cursorPointerEvent({ pointerType, pointerId: 2 }));
    flush();
    const decoration = cursor.nodes[activeTool === "eraser" ? 0 : 1]!;
    expect(decoration.attributes.get("visibility")).toBe("visible");
    expect(cursor.attributes.get("display")).toBe("inline");
    // Leaving the canvas and pen proximity loss both produce a pointerleave.
    h.surface.dispatchEvent(
      Object.assign(new Event("pointerleave"), {
        pointerId: departureType === pointerType ? 2 : 1,
        pointerType: departureType,
        buttons: 0,
        relatedTarget: null,
      }),
    );
    flush();
    expect(cursor.attributes.get("display")).toBe("none");
    h.controller.refresh();
    flush();
    expect(cursor.attributes.get("display")).toBe("none");
    h.surface.dispatchEvent(cursorPointerEvent({ pointerType, pointerId: 2 }));
    flush();
    expect(cursor.attributes.get("display")).toBe("inline");
    expect(cursor.nodes[activeTool === "eraser" ? 0 : 1]).toBe(decoration);
    h.controller.dispose();
    renderer.destroy();
  },
);
