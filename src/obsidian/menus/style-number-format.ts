import type { StyleControl } from "./editor-menu-types";

export function formatStyleNumber(value: number, id: string): string {
  return id === "text-font-size"
    ? String(value < 1 || value > 100 ? value : Math.round(value))
    : formatNumber(value);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "");
}

export function valueCharacterWidth(
  control: Extract<StyleControl, { kind: "number" }>,
  scale: number,
  placeholder: string,
): number {
  return Math.max(
    formatNumber(control.min * scale).length,
    formatNumber(control.max * scale).length,
    control.value === null ? 0 : formatStyleNumber(control.value * scale, control.id).length,
    placeholder.length,
  );
}
