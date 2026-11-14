import { afterEach, expect, it, vi } from "vitest";

import { SceneDom } from "../../../../src/rendering/scene/scene-dom";
import { asElement, FakeDocument, FakeNode, fakeNode } from "../../../unit/rendering/scene/fakes";

afterEach(() => vi.restoreAllMocks());

it("reveals a prepared 10,000-path scene through fixed boundaries without inherited writes or traversal", () => {
  const { container, scene, read } = themeFixture("hidden");
  const content = fakeNode(scene.contentGroup);
  const live = fakeNode(scene.liveStrokeGroup);
  const overlay = fakeNode(scene.selectionOverlayPath).parent!;
  const foreground = [
    fakeNode(scene.highlightGroup),
    content,
    fakeNode(scene.motionGroup),
    fakeNode(scene.liveGroup),
    live,
    fakeNode(scene.selectionTraceGroup),
    overlay,
  ];
  for (let index = 0; index < 10_000; index++)
    content.append(new FakeNode(content.ownerDocument, "path"));
  live.setAttribute("opacity", "0.6");
  const writes = foreground.map((group) => vi.spyOn(group.style, "removeProperty"));
  const bodyWrites = vi.spyOn(content.ownerDocument.body.style, "setProperty");
  const traversal = vi.spyOn(FakeNode.prototype, "children", "get");
  const childNodes = vi.spyOn(FakeNode.prototype, "childNodes", "get");
  const attributes = vi.spyOn(FakeNode.prototype, "setAttribute");
  read.mockClear();
  try {
    expect(foreground.every((group) => group.style.getPropertyValue("opacity") === "0")).toBe(true);
    scene.revealSurface();
    for (const write of writes) expect(write).toHaveBeenCalledExactlyOnceWith("opacity");
    expect(live.attributes.get("opacity")).toBe("0.6");
    expect(content.nodes).toHaveLength(10_000);
    scene.revealSurface();
    scene.writeSurface();
    for (const write of writes) expect(write).toHaveBeenCalledTimes(1);
    for (const boundary of [bodyWrites, traversal, childNodes, attributes, read])
      expect(boundary).not.toHaveBeenCalled();
    scene.release();
    scene.revealSurface();
    scene.writeSurface();
    for (const write of writes) expect(write).toHaveBeenCalledTimes(1);
    expect(container.children).toHaveLength(0);
  } finally {
    scene.release();
  }
});

it("bounds all host-token reads and changed writes independently of ten thousand retained paths", () => {
  const { scene, read, properties, tokens } = themeFixture("");
  const content = fakeNode(scene.contentGroup);
  for (let index = 0; index < 10_000; index++)
    content.append(new FakeNode(content.ownerDocument, "path"));
  const writes = vi.spyOn(content.ownerDocument.body.style, "setProperty");
  const traversal = vi.spyOn(FakeNode.prototype, "children", "get");
  const childNodes = vi.spyOn(FakeNode.prototype, "childNodes", "get");
  read.mockClear();
  properties.mockClear();
  try {
    const changedTokens = [
      "--text-error",
      "--background-secondary",
      "--code-normal",
      "--code-function",
      "--code-punctuation",
      "--code-keyword",
      "--code-string",
      "--code-comment",
      "--code-tag",
      "--code-property",
      "--code-value",
      "--text-selection",
      "--text-faint",
      "--text-accent",
    ];
    for (const token of changedTokens) tokens.set(token, "#123456");
    scene.invalidateSurfaceTheme();
    scene.invalidateSurfaceTheme();
    expect(read).not.toHaveBeenCalled();
    scene.readSurface();
    scene.readSurface();
    scene.writeSurface();
    scene.writeSurface();
    expect(read).toHaveBeenCalledOnce();
    // Sixteen consumed host tokens plus the existing foreground-readiness token, once each.
    expect(properties.mock.calls.map(([property]) => property)).toEqual([
      "--interactive-accent",
      "--text-normal",
      ...changedTokens,
      "--inkbook-scene-foreground-visibility",
    ]);
    expect(writes).toHaveBeenCalledTimes(14);
    read.mockClear();
    properties.mockClear();
    writes.mockClear();
    tokens.set("--code-function", "#abcdef");
    scene.invalidateSurfaceTheme();
    scene.readSurface();
    scene.writeSurface();
    scene.readSurface();
    scene.writeSurface();
    expect(read).toHaveBeenCalledOnce();
    expect(properties).toHaveBeenCalledTimes(17);
    expect(writes).toHaveBeenCalledExactlyOnceWith("--code-function", "#abcdef");
    expect(traversal).not.toHaveBeenCalled();
    expect(childNodes).not.toHaveBeenCalled();
  } finally {
    scene.release();
  }
});

function themeFixture(visibility: string) {
  const owner = new FakeDocument();
  const tokens = new Map([["--inkbook-scene-foreground-visibility", visibility]]);
  const properties = vi.fn((property: string) => tokens.get(property) ?? "");
  const read = vi.fn(() => ({ width: "700px", height: "2500px", getPropertyValue: properties }));
  Object.defineProperty(owner, "defaultView", { value: { getComputedStyle: read } });
  const container = new FakeNode(owner, "div");
  const scene = new SceneDom(asElement(container), "Canvas", {});
  return { scene, container, tokens, properties, read };
}
