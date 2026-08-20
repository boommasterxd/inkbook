import type { AreaGeometryV1, NotePointV1, SceneElementV1 } from "../model";

type ProjectionAvailabilityV1 =
  "current" | "stale" | "ambiguous" | "unavailable";

interface ProjectionTokenV1 {
  readonly availability: ProjectionAvailabilityV1;
  readonly invertible: boolean;
}

export interface GeometryProjectionV1 {
  readonly token: ProjectionTokenV1;
  projectPoint(element: SceneElementV1, point: NotePointV1): NotePointV1 | null;
  projectArea(
    element: SceneElementV1,
    area: AreaGeometryV1,
  ): AreaGeometryV1 | null;
  projectStroke(
    element: SceneElementV1,
    points: readonly NotePointV1[],
  ): readonly NotePointV1[] | null;
}

type GeometryFailureReasonV1 =
  | "projection-unavailable"
  | "projection-stale"
  | "projection-ambiguous"
  | "projection-non-invertible"
  | "projection-invalid"
  | "target-not-found"
  | "target-kind-unsupported"
  | "port-incompatible"
  | "stroke-points-unavailable"
  | "selection-empty";

export type GeometryResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: GeometryFailureReasonV1 };

export function geometrySuccessV1<T>(value: T): GeometryResultV1<T> {
  return Object.freeze({ ok: true, value });
}

export function geometryFailureV1(
  reason: GeometryFailureReasonV1,
): GeometryResultV1<never> {
  return Object.freeze({ ok: false, reason });
}

export function materializeGeometryPointV1(point: NotePointV1): NotePointV1 {
  return Object.freeze({ x: point.x, y: point.y });
}

export function validateProjectionV1(
  projection: GeometryProjectionV1,
): GeometryResultV1<true> {
  switch (projection.token.availability) {
    case "unavailable":
      return geometryFailureV1("projection-unavailable");
    case "stale":
      return geometryFailureV1("projection-stale");
    case "ambiguous":
      return geometryFailureV1("projection-ambiguous");
    case "current":
      return projection.token.invertible
        ? geometrySuccessV1(true)
        : geometryFailureV1("projection-non-invertible");
  }
}

export function isFinitePointV1(point: NotePointV1): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

export function isFiniteAreaV1(area: AreaGeometryV1): boolean {
  return (
    isFinitePointV1(area.center) &&
    Number.isFinite(area.width) &&
    area.width >= 0 &&
    Number.isFinite(area.height) &&
    area.height >= 0 &&
    Number.isFinite(area.rotationRadians)
  );
}
