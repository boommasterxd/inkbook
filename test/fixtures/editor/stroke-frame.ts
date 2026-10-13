export const STROKE_FRAME_CASES = [0, 1, 37].flatMap((rotation) =>
  (["none", "x", "y", "both"] as const).flatMap((collapsed) =>
    [false, true].map((extremePivot) => ({ rotation, collapsed, extremePivot })),
  ),
);
