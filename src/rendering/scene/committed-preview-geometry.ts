import type { PreparedPressureGeometryPort } from "../../domain/geometry/prepared-pressure-geometry";
import type { SvgPathPart } from "../../domain/geometry/element-path";
import { ProgressivePreviewPath } from "./progressive-preview-path";
import type { PreviewTransform } from "./scene-visibility-reconciler";
import type { SceneElementRecord } from "./types";

interface RetainedTransform {
  readonly base: string | null;
  readonly strokeWidthScale: number | null;
  desired: PreviewTransform;
}

/** Retains committed feedback while one versioned canonical replacement is prepared. */
export class CommittedPreviewGeometry {
  readonly #transforms = new Map<string, RetainedTransform>();
  #job: { id: string; version: number; path: ProgressivePreviewPath } | undefined;

  public retain(id: string, base: string | null, strokeWidthScale: number | null): void {
    this.#transforms.set(id, {
      base,
      strokeWidthScale,
      desired: { transform: null, strokeWidthScale: null, version: Number.MAX_SAFE_INTEGER },
    });
    if (this.#job?.id === id) this.#job = undefined;
  }

  public has(id: string): boolean {
    return this.#transforms.has(id);
  }

  public resolve(id: string, desired: PreviewTransform): PreviewTransform {
    const retained = this.#transforms.get(id);
    if (retained === undefined) return desired;
    retained.desired = desired;
    const transform = [desired.transform, retained.base].filter(Boolean).join(" ") || null;
    return {
      ...desired,
      transform,
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
      this.#job = {
        id: record.id,
        version: record.geometryVersion,
        path: new ProgressivePreviewPath(record.element, pressureGeometry),
      };
      if (record.element.kind === "stroke" && record.element.points.length > 256 * 3)
        return undefined;
    }
    for (let step = 0; step < 4 && (step === 0 || now() < deadline); step++) {
      if (this.#job.path.step(deadline, now)) return this.#job.path.parts;
    }
    return undefined;
  }

  public finish(id: string): PreviewTransform | undefined {
    const desired = this.#transforms.get(id)?.desired;
    this.#transforms.delete(id);
    if (this.#job?.id === id) this.#job = undefined;
    return desired;
  }

  public memoryUsage(): number {
    let bytes = this.#job?.path.memoryUsage() ?? 0;
    for (const [id, { base, desired }] of this.#transforms)
      bytes += 32 + 2 * (id.length + (base?.length ?? 0) + (desired.transform?.length ?? 0));
    return bytes;
  }

  public release(): void {
    this.#transforms.clear();
    this.#job = undefined;
  }
}
