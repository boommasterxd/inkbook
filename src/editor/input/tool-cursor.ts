import type { ColorV1, ToolDefaultsV1 } from "../../domain/settings/types";
import type { InputInteraction, InputState, PointerDownAction, PointerSample } from "./input-types";

export type ToolSystemCursor =
  | "default"
  | "crosshair"
  | "move"
  | "grab"
  | "grabbing"
  | "ew-resize"
  | "ns-resize"
  | "nesw-resize"
  | "nwse-resize";

export interface ToolCursor {
  readonly system: ToolSystemCursor;
  readonly overlay:
    | { readonly kind: "eraser"; readonly radius: number }
    | {
        readonly kind: "tool";
        readonly tool: InputState["activeTool"];
        readonly color: ColorV1;
        readonly opacity: number;
        readonly fillColor?: ColorV1 | null;
        readonly fillOpacity?: number;
      }
    | undefined;
}

export interface ToolCursorOptions {
  readonly state: InputState;
  readonly defaults: ToolDefaultsV1;
  readonly pointer:
    | (Pick<PointerSample, "pointerId" | "pointerType"> &
        Partial<Pick<PointerDownAction, "penRole" | "controlOrMeta">>)
    | undefined;
  readonly suppressed?: boolean;
  readonly systemHint?: ToolSystemCursor;
}

const DEFAULT_CURSOR: ToolCursor = { system: "default", overlay: undefined };
const MOVE_CURSOR: ToolCursor = { system: "move", overlay: undefined };
const PAN_CURSOR: ToolCursor = { system: "grabbing", overlay: undefined };

export function resolveToolCursor(options: ToolCursorOptions): ToolCursor {
  const { state, defaults, pointer } = options;
  if (options.suppressed === true || pointer === undefined) return DEFAULT_CURSOR;
  const interaction = state.interaction;
  const activeCursor = interactionCursor(interaction, pointer, defaults);
  if (activeCursor !== undefined) return activeCursor;
  if (pointer.pointerType === "touch") return DEFAULT_CURSOR;
  const tool =
    interaction !== undefined && interaction.phase !== "pinch"
      ? interaction.tool
      : state.activeTool;
  if (interaction === undefined && usesHoverEraser(options)) return eraserCursor(defaults);
  if (interaction === undefined && options.systemHint !== undefined) {
    return { system: options.systemHint, overlay: undefined };
  }
  if (tool === "eraser") return eraserCursor(defaults);
  return {
    system: "crosshair",
    overlay: { kind: "tool", tool, ...toolPaint(tool, defaults) },
  };
}

function interactionCursor(
  interaction: InputInteraction | undefined,
  pointer: NonNullable<ToolCursorOptions["pointer"]>,
  defaults: ToolDefaultsV1,
): ToolCursor | undefined {
  if (interaction === undefined) return undefined;
  if (interaction.phase === "pinch" || interaction.pointerId !== pointer.pointerId)
    return DEFAULT_CURSOR;
  switch (interaction.phase) {
    case "element-move":
      return MOVE_CURSOR;
    case "page-pan":
    case "note-scroll":
      return PAN_CURSOR;
    case "eraser-gesture":
      return eraserCursor(defaults, pointer.pointerType === "touch" ? "default" : "crosshair");
    case "touch-pending":
      return DEFAULT_CURSOR;
    case "lasso":
    case "tool-gesture":
      return undefined;
  }
}

function usesHoverEraser({ state, pointer }: ToolCursorOptions): boolean {
  if (state.activeTool === "select" || pointer === undefined) return false;
  return (
    pointer.controlOrMeta === true ||
    (pointer.pointerType === "pen" && pointer.penRole !== undefined && pointer.penRole !== "normal")
  );
}

function eraserCursor(
  defaults: ToolDefaultsV1,
  system: ToolSystemCursor = "crosshair",
): ToolCursor {
  return { system, overlay: { kind: "eraser", radius: defaults.eraser.radius } };
}

function toolPaint(
  tool: Exclude<InputState["activeTool"], "eraser">,
  defaults: ToolDefaultsV1,
): { color: ColorV1; opacity: number; fillColor?: ColorV1 | null; fillOpacity?: number } {
  switch (tool) {
    case "draw":
      return { color: defaults.pen.color, opacity: defaults.pen.opacity };
    case "highlighter":
      return { color: defaults.highlighter.color, opacity: defaults.highlighter.opacity };
    case "straight-highlighter":
      return {
        color: defaults.straightHighlighter.color,
        opacity: defaults.straightHighlighter.opacity,
      };
    case "select":
      return { color: { type: "theme-text" }, opacity: 1 };
    default: {
      const style = defaults.shapes[tool];
      return {
        color: style.outlineColor,
        opacity: style.outlineOpacity,
        ...("fillColor" in style
          ? { fillColor: style.fillColor, fillOpacity: style.fillOpacity }
          : {}),
      };
    }
  }
}
