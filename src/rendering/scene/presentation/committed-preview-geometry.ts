import { composeMatrices, matrixString, IDENTITY_MATRIX } from "./selection-run-residuals";
import type { PreparedPressureGeometryPort } from "../../../domain/geometry/pressure/prepared-pressure-geometry";
import type { SvgPathPart } from "../../../domain/geometry/element-path";
import { ProgressivePreviewPath } from "../content/progressive-preview-path";
import type { PreviewTransform } from "../reconciliation/scene-visibility-reconciler";
import type { SceneElementRecord } from "../types";
import type { InkElementV1 } from "../../../domain/schema/public";
import type { MountedSceneElement } from "../content/mounted-element";

interface RetainedTransform {
  readonly base: string | null;
  readonly matrix: PreviewTransform["matrix"];
  readonly strokeWidthScale: number | null;
  bytes: number;
  desired: PreviewTransform;
}

/** Retains committed feedback while one versioned canonical replacement is prepared. */
export class CommittedPreviewGeometry {
  readonly #transforms = new Map<string, RetainedTransform>();
  #transformBytes = 0;
  #job: { id: string; version: number; path: ProgressivePreviewPath } | undefined;

  public retainPreviews(
    previews: ReadonlyMap<string, PreviewTransform>,
    elements: ReadonlyMap<string, InkElementV1>,
    context: {
      readonly dirty: ReadonlySet<string>;
      readonly mounted: ReadonlyMap<string, MountedSceneElement>;
    },
  ): void {
    const ids = new Set([...previews.keys(), ...elements.keys()]);
    for (const id of ids) {
      if (!context.dirty.has(id) || (previews.get(id)?.transform == null && !elements.has(id)))
        continue;
      const entry = context.mounted.get(id);
      if (entry !== undefined)
        this.retain(
          id,
          entry.appliedPreviewTransform,
          entry.previewStrokeWidthScale,
          entry.appliedPreviewMatrix,
        );
    }
  }

  public retain(
    id: string,
    base: string | null,
    strokeWidthScale: number | null,
    matrix?: PreviewTransform["matrix"],
  ): void {
    matrix = knownMatrix(base, matrix);
    if (base !== null && matrix !== undefined) base = matrixString(matrix);
    const bytes = 88 + 2 * (id.length + (base?.length ?? 0));
    this.#transformBytes += bytes - (this.#transforms.get(id)?.bytes ?? 0);
    this.#transforms.set(id, {
      base,
      matrix,
      bytes,
      strokeWidthScale,
      desired: {
        transform: null,
        strokeWidthScale: null,
        version: Number.MAX_SAFE_INTEGER,
      },
    });
    if (this.#job?.id === id) {
      this.#job.path.cancel();
      this.#job = undefined;
    }
  }

  public has(id: string): boolean {
    return this.#transforms.has(id);
  }

  public resolve(id: string, desired: PreviewTransform): PreviewTransform {
    const retained = this.#transforms.get(id);
    if (retained === undefined) return desired;
    const bytes =
      136 + 2 * (id.length + (retained.base?.length ?? 0) + (desired.transform?.length ?? 0));
    this.#transformBytes += bytes - retained.bytes;
    retained.bytes = bytes;
    retained.desired = desired;
    const next = knownMatrix(desired.transform, desired.matrix);
    const composed =
      retained.matrix === undefined || next === undefined
        ? undefined
        : composeMatrices(next, retained.matrix);
    const matrix = composed?.every(Number.isFinite) ? composed : undefined;
    const transform =
      matrix === undefined
        ? [desired.transform, retained.base].filter(Boolean).join(" ") || null
        : matrixString(matrix);
    return {
      ...desired,
      transform,
      matrix,
      strokeWidthScale: desired.strokeWidthScale ?? retained.strokeWidthScale,
    };
  }

  public prepare(
    record: SceneElementRecord,
    deadline: number,
    now: () => number,
    pressureGeometry?: PreparedPressureGeometryPort,
  ): readonly SvgPathPart[] | undefined {
    if (this.#job?.id !== record.id || this.#job.version !== record.geometryVersion) {
      this.#job?.path.cancel();
      this.#job = {
        id: record.id,
        version: record.geometryVersion,
        path: new ProgressivePreviewPath(record.element, pressureGeometry),
      };
    }
    let stepped = false;
    while (!stepped || now() < deadline) {
      stepped = true;
      if (this.#job.path.step(deadline, now)) return this.#job.path.parts;
    }
    return undefined;
  }

  public finish(id: string): PreviewTransform | undefined {
    const retained = this.#transforms.get(id);
    const desired = retained?.desired;
    this.#transformBytes -= retained?.bytes ?? 0;
    this.#transforms.delete(id);
    if (this.#job?.id === id) {
      this.#job.path.cancel();
      this.#job = undefined;
    }
    return desired;
  }

  public memoryUsage(): number {
    return this.#transformBytes + (this.#job?.path.memoryUsage() ?? 0);
  }

  public release(): void {
    this.#transforms.clear();
    this.#transformBytes = 0;
    this.#job?.path.cancel();
    this.#job = undefined;
  }
}

function knownMatrix(
  transform: string | null,
  matrix: PreviewTransform["matrix"],
): PreviewTransform["matrix"] {
  if (transform === null) return IDENTITY_MATRIX;
  return matrix?.every(Number.isFinite) ? matrix : undefined;
}
