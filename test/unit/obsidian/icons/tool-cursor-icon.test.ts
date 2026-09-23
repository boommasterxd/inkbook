// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { ARROW_NODES, STARTUP_TOOLS } from "../../../../src/domain/settings/types";
import { createToolCursorIcon } from "../../../../src/obsidian/icons/tool-cursor-icon";
import {
  activeShapeIconId,
  DRAWING_TOOL_ICON_IDS,
  selectionAreaIconId,
} from "../../../../src/rendering/ui/icon-ids";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const source = document.createElementNS(SVG_NAMESPACE, "svg");
  const nested = document.createElementNS(SVG_NAMESPACE, "svg");
  nested.setAttribute("viewBox", "0 0 24 24");
  nested.setAttribute("stroke", "currentColor");
  const path = document.createElementNS(SVG_NAMESPACE, "path");
  path.setAttribute("d", "M4 12h16");
  nested.append(path);
  source.append(nested);
  const getIcon = vi.spyOn(obsidian, "getIcon").mockReturnValue(source);
  const owner = document.implementation.createHTMLDocument();
  const importNode = vi.spyOn(owner, "importNode");
  return {
    defaults: createBuiltInSettings().toolDefaults,
    getIcon,
    importNode,
    owner,
    resolve: createToolCursorIcon(owner),
    source,
  };
}

describe("toolbar cursor icon adapter", () => {
  it("uses the toolbar IDs for every tool, selection area and coordinate dimension", () => {
    const h = setup();
    for (const tool of STARTUP_TOOLS) {
      if (tool === "eraser") continue;
      h.resolve(tool, h.defaults);
      const expected =
        tool === "select"
          ? selectionAreaIconId(h.defaults.select.area)
          : tool === "draw" || tool === "highlighter" || tool === "straight-highlighter"
            ? DRAWING_TOOL_ICON_IDS[tool]
            : activeShapeIconId(tool, {
                arrowStart: h.defaults.arrow.startNode,
                arrowEnd: h.defaults.arrow.endNode,
                coordinateDimension: h.defaults.coordinateSystem.dimension,
              });
      expect(h.getIcon).toHaveBeenLastCalledWith(expected);
    }
    for (const area of ["rectangle", "lasso"] as const) {
      h.defaults.select.area = area;
      h.resolve("select", h.defaults);
      expect(h.getIcon).toHaveBeenLastCalledWith(selectionAreaIconId(area));
    }
    for (const dimension of ["2d", "3d"] as const) {
      h.defaults.coordinateSystem.dimension = dimension;
      h.resolve("coordinate-system", h.defaults);
      expect(h.getIcon).toHaveBeenLastCalledWith(
        activeShapeIconId("coordinate-system", {
          arrowStart: "none",
          arrowEnd: "none",
          coordinateDimension: dimension,
        }),
      );
    }
  });

  it("resolves all 25 toolbar arrowhead combinations without collapsing variants", () => {
    const h = setup();
    const nodes = new Set<SVGSVGElement | undefined>();
    for (const start of ARROW_NODES) {
      for (const end of ARROW_NODES) {
        h.defaults.arrow = { startNode: start, endNode: end };
        nodes.add(h.resolve("arrow", h.defaults));
        expect(h.getIcon).toHaveBeenLastCalledWith(
          activeShapeIconId("arrow", {
            arrowStart: start,
            arrowEnd: end,
            coordinateDimension: "2d",
          }),
        );
      }
    }
    expect(h.getIcon).toHaveBeenCalledTimes(25);
    expect(nodes.size).toBe(25);
  });

  it("imports nested icon geometry once into the owning document and reuses it across style changes", () => {
    const h = setup();
    const icon = h.resolve("draw", h.defaults);
    expect(icon).not.toBe(h.source);
    expect(icon?.ownerDocument).toBe(h.owner);
    expect(icon?.outerHTML).toBe(h.source.outerHTML);
    h.defaults.pen.color = { type: "rgba", value: "#123456" };
    h.defaults.pen.opacity = 0.2;
    h.defaults.pen.width = 22;
    for (let move = 0; move < 200; move++) expect(h.resolve("draw", h.defaults)).toBe(icon);
    expect(h.getIcon).toHaveBeenCalledOnce();
    expect(h.importNode).toHaveBeenCalledExactlyOnceWith(h.source, true);
    h.resolve("highlighter", h.defaults);
    expect(h.resolve("draw", h.defaults)).not.toBe(icon);
    expect(h.getIcon).toHaveBeenCalledTimes(3);
  });

  it("caches missing icons and uses no icon for the eraser", () => {
    const h = setup();
    h.getIcon.mockReturnValue(null);
    expect(h.resolve("eraser", h.defaults)).toBeUndefined();
    expect(h.getIcon).not.toHaveBeenCalled();
    for (let move = 0; move < 200; move++) {
      expect(h.resolve("draw", h.defaults)).toBeUndefined();
    }
    expect(h.getIcon).toHaveBeenCalledOnce();
    expect(h.importNode).not.toHaveBeenCalled();
    expect(h.resolve("eraser", h.defaults)).toBeUndefined();
    expect(h.getIcon).toHaveBeenCalledOnce();
    h.getIcon.mockReturnValue(h.source);
    expect(h.resolve("draw", h.defaults)).toBeDefined();
  });
});
