import type { SvgPathPart } from "../../../domain/geometry/element-path";
import type { PreparedPressureGeometryPort } from "../../../domain/geometry/pressure/prepared-pressure-geometry";
import type { SceneElementRecord } from "../types";
import type { CommittedPreviewGeometry } from "../presentation/committed-preview-geometry";
import type { SceneSelectionRuns } from "../presentation/selection-runs";
import type { ScenePathCache } from "./path-cache";
import type { MountedSceneElement } from "./mounted-element";
import { sameStrokeShape } from "./stroke-position";

interface GeometryPathContext {
  readonly currentVersion: boolean;
  readonly pressure: PreparedPressureGeometryPort | undefined;
  readonly deadline: number;
  readonly now: () => number;
  readonly retained: CommittedPreviewGeometry;
  readonly runs: SceneSelectionRuns;
  readonly paths: ScenePathCache;
  readonly prepare: (
    record: SceneElementRecord,
    deadline: number,
    now: () => number,
    preempt: boolean,
  ) => readonly SvgPathPart[] | undefined;
}

/** Reuses displayed or cached geometry before admitting one canonical replacement. */
export function mountedGeometryPath(
  entry: MountedSceneElement,
  record: SceneElementRecord,
  context: GeometryPathContext,
): readonly SvgPathPart[] | undefined {
  if (record.element.kind === "text") return [];
  const { retained, runs, paths, pressure, deadline, now } = context;
  const pending =
    retained.has(record.id) ||
    (runs.committing && runs.grouped(record.id)) ||
    (record.element.kind === "stroke" && record.element.style.pressureEnabled);
  const existing = sameStrokeShape(entry.displayedElement, record.element)
    ? entry.displayedPathParts
    : undefined;
  return (
    existing ??
    paths.read(record.element, pressure, record.geometryVersion) ??
    (pending
      ? record.element.kind === "stroke" && context.currentVersion
        ? context.prepare(record, deadline, now, runs.committing)
        : retained.prepare(record, deadline, now, pressure)
      : paths.build(record.element, pressure))
  );
}
