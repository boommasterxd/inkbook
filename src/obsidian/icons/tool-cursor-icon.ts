import { getIcon } from "obsidian";
import type { ToolDefaultsV1 } from "../../domain/settings/types";
import type { InputState } from "../../editor/input/input-types";
import {
  activeShapeIconId,
  DRAWING_TOOL_ICON_IDS,
  selectionAreaIconId,
} from "../../rendering/ui/icon-ids";

function iconId(tool: InputState["activeTool"], defaults: ToolDefaultsV1): string | undefined {
  if (tool === "eraser") return undefined;
  if (tool === "select") return selectionAreaIconId(defaults.select.area);
  if (tool === "draw" || tool === "highlighter" || tool === "straight-highlighter") {
    return DRAWING_TOOL_ICON_IDS[tool];
  }
  return activeShapeIconId(tool, {
    arrowStart: defaults.arrow.startNode,
    arrowEnd: defaults.arrow.endNode,
    coordinateDimension: defaults.coordinateSystem.dimension,
  });
}

/** Retains only the latest toolbar icon, including a missing-icon result. */
export function createToolCursorIcon(
  ownerDocument: Document,
): (tool: InputState["activeTool"], defaults: ToolDefaultsV1) => SVGSVGElement | undefined {
  let previousId: string | undefined;
  let previousIcon: SVGSVGElement | undefined;
  return (tool, defaults) => {
    const id = iconId(tool, defaults);
    if (id === previousId) return previousIcon;
    previousId = id;
    const source = id === undefined ? null : getIcon(id);
    previousIcon = source === null ? undefined : ownerDocument.importNode(source, true);
    return previousIcon;
  };
}
