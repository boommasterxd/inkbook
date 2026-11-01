import { describe, expect, it } from "vitest";
import { convertObsidianInk } from "../../../../../src/persistence/import/obsidian-ink/convert";
import { inkSvg, tldrawShape, tldrawSnapshot } from "./fixtures";

const options = () => ({
  timestamp: 100,
  signal: new AbortController().signal,
  checkpoint: () => undefined,
});

describe("Legacy shape semantics", () => {
  it.each([
    ["rectangle", "rectangle"],
    ["ellipse", "ellipse"],
    ["triangle", "triangle"],
    ["diamond", "diamond"],
    ["octagon", "octagon"],
    ["rhombus", "parallelogram"],
  ])("transfers supported %s geometry to the current %s native element", async (geo, kind) => {
    const source = tldrawSnapshot([
      tldrawShape("shape:geometry", "geo", { geo, w: 80, h: 40, growY: 10, fill: "semi" }),
    ]);
    const result = await convertObsidianInk(inkSvg(source, "tldraw"), options());
    expect(result.snapshot.elements[0]).toMatchObject({
      kind,
      x: 124.3,
      y: 224.3,
      width: 80,
      height: 50,
      style: { fillColor: { value: "#E8E8E8FF" }, fillOpacity: 1 },
    });
  });

  it("bakes group placement, rotation and opacity into an editable child without losing stacking order", async () => {
    const group = tldrawShape("shape:group", "group");
    Object.assign(group, { x: 100, y: 100, rotation: Math.PI / 2, opacity: 0.5 });
    const child = tldrawShape("shape:child");
    Object.assign(child, { parentId: group.id, x: 20, y: 0, opacity: 0.8 });
    const result = await convertObsidianInk(
      inkSvg(tldrawSnapshot([child, group]), "tldraw"),
      options(),
    );
    expect(result.snapshot.elements).toHaveLength(1);
    expect(result.snapshot.elements[0]).toMatchObject({
      kind: "stroke",
      rotation: 90,
      pivot: { x: 124.3, y: 144.3 },
      offset: { x: 124.3, y: 144.3 },
      style: { opacity: 0.4 },
    });
  });

  it("resolves saved bound arrow anchors and explains detachment from legacy geometry", async () => {
    const box = {
      ...tldrawShape("shape:box", "geo", { geo: "rectangle", w: 80, h: 40 }),
      index: "a1",
    };
    const arrow = {
      ...tldrawShape("shape:arrow", "arrow", {
        start: { type: "binding", boundShapeId: box.id, normalizedAnchor: { x: 1, y: 0.5 } },
        end: { type: "point", x: 200, y: 0 },
      }),
      index: "a2",
    };
    const result = await convertObsidianInk(
      inkSvg(tldrawSnapshot([arrow, box]), "tldraw"),
      options(),
    );
    expect(result.snapshot.elements[1]).toMatchObject({
      kind: "arrow",
      start: { x: 204.3, y: 244.3 },
      end: { x: 324.3, y: 224.3 },
      startConnection: null,
    });
    expect(result.warnings).toContain(
      "Legacy arrow bindings were detached at their saved normalized anchors.",
    );
  });

  it("preserves straight line endpoint handles and fails an unsupported polyline without discarding it", async () => {
    const handles = { end: { x: 40, y: 30, index: "a2" }, start: { x: 5, y: 10, index: "a1" } };
    const line = tldrawShape("shape:line", "line", { handles, spline: "line" });
    const imported = await convertObsidianInk(inkSvg(tldrawSnapshot([line]), "tldraw"), options());
    expect(imported.snapshot.elements[0]).toMatchObject({
      kind: "line",
      start: { x: 129.3, y: 234.3 },
      end: { x: 164.3, y: 254.3 },
    });
    Object.assign(handles, { middle: { x: 10, y: 10, index: "a15" } });
    await expect(
      convertObsidianInk(inkSvg(tldrawSnapshot([line]), "tldraw"), options()),
    ).rejects.toMatchObject({ code: "unsupported-content" });
  });
});
