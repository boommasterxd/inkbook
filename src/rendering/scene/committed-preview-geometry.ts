import type { PreparedPressureGeometryPort } from "../../domain/geometry/prepared-pressure-geometry";
import type { SvgPathPart } from "../../domain/geometry/element-path";
import { ProgressivePreviewPath } from "./progressive-preview-path";
import type { PreviewTransform } from "./scene-visibility-reconciler";
import type { SceneElementRecord } from "./types";
import type { InkElementV1 } from "../../domain/schema/public";
import type { MountedSceneElement } from "./mounted-element";

interface RetainedTransform {
  readonly base: string | null;
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
        this.retain(id, entry.appliedPreviewTransform, entry.previewStrokeWidthScale);
    }
  }

  public retain(id: string, base: string | null, strokeWidthScale: number | null): void {
    const bytes = 40 + 2 * (id.length + (base?.length ?? 0));
    this.#transformBytes += bytes - (this.#transforms.get(id)?.bytes ?? 0);
    this.#transforms.set(id, {
      base,
      bytes,
      strokeWidthScale,
      desired: { transform: null, strokeWidthScale: null, version: Number.MAX_SAFE_INTEGER },
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
      40 + 2 * (id.length + (retained.base?.length ?? 0) + (desired.transform?.length ?? 0));
    this.#transformBytes += bytes - retained.bytes;
    retained.bytes = bytes;
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
