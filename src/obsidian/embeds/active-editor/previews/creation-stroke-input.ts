import type { StrokeStyleV1 } from "../../../../domain/schema/public";
import type { ToolDefaultsV1 } from "../../../../domain/settings/types";

export function inputPressure(pressure: number | undefined, source: "pen" | "simulated"): number {
  if (source === "simulated") return 0.5;
  if (pressure === undefined) return 0.5;
  if (!Number.isFinite(pressure)) throw new RangeError("Pen pressure must be finite.");
  return Math.min(1, Math.max(0, pressure));
}

export function strokeStyle(defaults: ToolDefaultsV1, tool: "draw" | "highlighter"): StrokeStyleV1 {
  const source = tool === "draw" ? defaults.pen : defaults.highlighter;
  return {
    color: structuredClone(source.color),
    opacity: source.opacity,
    pressureEnabled: tool === "draw" ? defaults.pen.pressureEnabled : false,
    smoothing: 0.5,
    width: source.width,
  };
}
