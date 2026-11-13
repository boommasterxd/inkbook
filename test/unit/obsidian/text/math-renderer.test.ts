// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  loadMathJax: vi.fn(async () => {}),
  renderMath: vi.fn<(source: string, display: boolean) => HTMLElement>(),
  finishRenderMath: vi.fn(async () => {}),
}));
vi.mock("obsidian", () => host);

import { ObsidianTextMathRenderer } from "../../../../src/obsidian/text/math-renderer";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";

describe("public Obsidian math adaptation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    host.renderMath.mockImplementation(() => document.createElement("mjx-container"));
  });

  it("reflows a cold width-bound equation and reverses width without unused public host work", async () => {
    const renderer = new ObsidianTextMathRenderer(createTestWorkScheduler());
    try {
      const initial = await renderer.resolve("x+1", false, 24, undefined, 120);
      const narrow = await renderer.resolve("x+1", false, 24, undefined, 20);
      const reversed = await renderer.resolve("x+1", false, 24, undefined, 120);
      expect(initial.paths).toHaveLength(3);
      expect(initial.width).toBeGreaterThan(50);
      expect(narrow.width).toBeLessThanOrEqual(20);
      expect(narrow.paths.length).toBeGreaterThan(0);
      expect(reversed).toBe(initial);
      expect(host.loadMathJax).not.toHaveBeenCalled();
      expect(host.renderMath).not.toHaveBeenCalled();
      expect(host.finishRenderMath).not.toHaveBeenCalled();
    } finally {
      renderer.dispose();
    }
  });

  it("detects native CHTML once and reuses the canonical offline SVG engine", async () => {
    const renderer = new ObsidianTextMathRenderer(createTestWorkScheduler());
    try {
      const initial = await renderer.resolve("x+1", false, 24);
      const repeated = await renderer.resolve("x+1", false, 24);
      expect(repeated).toBe(initial);
      expect(initial.paths.length).toBeGreaterThan(0);
      expect(host.loadMathJax).toHaveBeenCalledTimes(1);
      expect(host.renderMath).toHaveBeenCalledWith("x+1", false);
      expect(host.finishRenderMath).toHaveBeenCalledTimes(1);
    } finally {
      renderer.dispose();
    }
  });

  it("normalizes public SVG references, transforms and rectangles without retaining DOM or markup", async () => {
    host.renderMath.mockImplementation(() => {
      const node = document.createElement("span");
      const svg = new DOMParser().parseFromString(
        '<svg viewBox="0 -1000 2000 1500"><defs><path id="glyph" d="M0 0h1000v1000z"/></defs><g transform="scale(1 -1)"><use href="#glyph" x="200"/><rect x="0" y="-200" width="2000" height="50"/></g></svg>',
        "image/svg+xml",
      );
      node.append(document.importNode(svg.documentElement, true));
      return node;
    });
    const renderer = new ObsidianTextMathRenderer(createTestWorkScheduler());
    try {
      await renderer.resolve("x", true, 20, undefined, 120);
      expect(host.renderMath).not.toHaveBeenCalled();
      const result = await renderer.resolve("x", true, 20);
      expect(result).toMatchObject({ width: 40, height: 30, ascent: 20, descent: 10 });
      expect(result.paths).toEqual([
        { d: "M4 20 L24 20 L24 0 Z" },
        { d: "M0 24 L40 24 L40 23 L0 23 Z" },
      ]);
      await renderer.resolve("x", true, 20, undefined, undefined, { bold: true });
      expect(host.renderMath).toHaveBeenLastCalledWith("\\boldsymbol{x\n}", true);
      await renderer.resolve("x", true, 20, undefined, undefined, { bold: false });
      expect(host.renderMath).toHaveBeenLastCalledWith("x", true);
    } finally {
      renderer.dispose();
    }
  });

  it("falls back to a complete portable equation when native inline SVG is fragmented", async () => {
    host.renderMath.mockImplementation(() => {
      const node = document.createElement("span");
      for (let index = 0; index < 2; index += 1)
        node.append(document.createElementNS("http://www.w3.org/2000/svg", "svg"));
      return node;
    });
    const renderer = new ObsidianTextMathRenderer(createTestWorkScheduler());
    try {
      const value = await renderer.resolve("x+1", false, 24);
      expect(value.paths).toHaveLength(3);
      expect(value.width).toBeGreaterThan(50);
      expect(await renderer.resolve("x+1", false, 24)).toBe(value);
      expect(host.renderMath).toHaveBeenCalledOnce();
    } finally {
      renderer.dispose();
    }
  });

  it("rejects a stale formula before invoking native rendering", async () => {
    const aborted = new AbortController();
    aborted.abort(new Error("obsolete revision"));
    const renderer = new ObsidianTextMathRenderer(createTestWorkScheduler());
    await expect(renderer.resolve("x", false, 24, aborted.signal)).rejects.toThrow(
      "obsolete revision",
    );
    expect(host.renderMath).not.toHaveBeenCalled();
    renderer.dispose();
    await expect(renderer.resolve("x", false, 24)).rejects.toThrow("disposed");
  });
});
