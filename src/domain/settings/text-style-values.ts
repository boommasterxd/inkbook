import { isRgbaColor } from "../schema/public";

export function validateTextStyleValue(key: string, value: unknown): boolean {
  if (key === "fontFamily") return validFontFamily(value);
  if (key === "fontSize")
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 4096;
  if (key === "opacity" || key === "backgroundOpacity")
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  if (key === "alignment")
    return value === "left" || value === "center" || value === "right" || value === "justify";
  if (key === "color" || key === "backgroundColor")
    return validColor(value, key === "backgroundColor");
  return (
    ["bold", "italic", "underline", "strikethrough"].includes(key) && typeof value === "boolean"
  );
}

function validFontFamily(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !value.includes("\u0000")
  );
}

function validColor(value: unknown, nullable: boolean): boolean {
  if (value === null) return nullable;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const color = value as { type?: unknown; value?: unknown };
  if (color.type === "theme-text") return Object.keys(color).length === 1;
  return color.type === "rgba" && Object.keys(color).length === 2 && isRgbaColor(color.value);
}
