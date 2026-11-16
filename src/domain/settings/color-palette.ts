const COLOR_ENTRIES = [
  ["black", "#000000FF"],
  ["dark-gray", "#374151FF"],
  ["light-gray", "#D1D5DBFF"],
  ["white", "#FFFFFFFF"],
  ["gray", "#6B7280FF"],
  ["yellow", "#EAB308FF"],
  ["amber", "#F59E0BFF"],
  ["orange", "#F97316FF"],
  ["brown", "#92400EFF"],
  ["red", "#EF4444FF"],
  ["pink", "#EC4899FF"],
  ["violet", "#8B5CF6FF"],
  ["indigo", "#6366F1FF"],
  ["blue", "#3B82F6FF"],
  ["lime", "#84CC16FF"],
  ["green", "#22C55EFF"],
  ["teal", "#0F766EFF"],
  ["cyan", "#06B6D4FF"],
  ["sky", "#7DD3FCFF"],
] as const;

/** Shared theme and fixed colors with stable names for every drawing color control. */
export const BUILT_IN_COLOR_OPTIONS = Object.freeze([
  Object.freeze({
    key: "theme-text" as const,
    color: Object.freeze({ type: "theme-text" as const }),
  }),
  ...COLOR_ENTRIES.map(([key, value]) =>
    Object.freeze({ key, color: Object.freeze({ type: "rgba" as const, value }) }),
  ),
]);

export const BUILT_IN_COLORS = Object.freeze(BUILT_IN_COLOR_OPTIONS.map(({ color }) => color));

export const DEFAULT_INK_COLOR = BUILT_IN_COLORS[0]!;
