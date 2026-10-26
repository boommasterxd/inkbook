import type { SelectionPreviewTransform } from "../handle-types";

type Matrix = readonly [number, number, number, number, number, number];

/** Matches the SVG transform list while keeping full-precision numeric feedback. */
export function selectionPreviewMatrix(
  transform: SelectionPreviewTransform | null,
): Matrix | undefined {
  if (transform === null) return undefined;
  if (transform.kind === "translate") return [1, 0, 0, 1, transform.delta.x, transform.delta.y];
  if (transform.kind === "scale") return scaleFeedbackMatrix(transform);
  const angle = (transform.degrees * Math.PI) / 180;
  const c = Math.cos(angle),
    s = Math.sin(angle),
    { x, y } = transform.center;
  return [c, s, -s, c, x - c * x + s * y, y - s * x - c * y];
}

function scaleFeedbackMatrix(
  transform: Extract<SelectionPreviewTransform, { kind: "scale" }>,
): Matrix {
  const angle = (transform.rotation * Math.PI) / 180;
  const c = Math.cos(angle),
    s = Math.sin(angle);
  const x = transform.factors.x,
    y = transform.factors.y;
  const a = c * c * x + s * s * y,
    b = c * s * (x - y),
    d = s * s * x + c * c * y;
  return [
    a,
    b,
    b,
    d,
    transform.delta.x + transform.anchor.x - a * transform.anchor.x - b * transform.anchor.y,
    transform.delta.y + transform.anchor.y - b * transform.anchor.x - d * transform.anchor.y,
  ];
}
