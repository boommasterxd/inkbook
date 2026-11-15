import type { ImageResourceV3, InkSnapshotV1 } from "../../../domain/schema/public";
import { IMAGE_LIMITS } from "../../../domain/images/image-limits";
import { assertImageResourcesSteps } from "../../../domain/schema/image-validation";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import {
  canonicalImageResource,
  validateImageResource,
} from "../../../persistence/images/image-resources";

/** Retain admitted assets for the complete session, including undo/redo history. */
export class SessionImageResources {
  #resources: readonly ImageResourceV3[];
  #byId: ReadonlyMap<string, ImageResourceV3>;
  #pending: Promise<void> = Promise.resolve();
  #changed = false;

  constructor(snapshot: InkSnapshotV1) {
    this.#resources = Object.freeze((snapshot.imageResources ?? []).map(captureResource));
    this.#byId = new Map(this.#resources.map((resource) => [resource.id, resource]));
  }

  get resources(): readonly ImageResourceV3[] {
    return this.#resources;
  }

  get changes(): readonly ImageResourceV3[] | undefined {
    return this.#changed ? this.#resources : undefined;
  }

  acknowledge(): void {
    this.#changed = false;
  }

  resource(id: string): ImageResourceV3 | undefined {
    return this.#byId.get(id);
  }

  add(
    resources: readonly ImageResourceV3[],
    context: { readonly active: () => boolean; readonly scheduler: WorkScheduler },
  ): Promise<void> {
    if (resources.length > IMAGE_LIMITS.resources)
      return Promise.reject(new RangeError("Too many image resources."));
    const captured = resources.map(captureResource);
    const operation = this.#pending.then(() => this.#admit(captured, context));
    this.#pending = operation.catch(() => undefined);
    return operation;
  }

  async #admit(
    captured: readonly ImageResourceV3[],
    context: { readonly active: () => boolean; readonly scheduler: WorkScheduler },
  ): Promise<void> {
    if (!context.active()) throw new Error("The document session is unavailable.");
    const merged = mergeResources(this.#resources, captured);
    if (merged.length === this.#resources.length) return;
    if (
      merged.length > IMAGE_LIMITS.resources ||
      merged.reduce((bytes, resource) => bytes + resourceBytes(resource), 0) >
        IMAGE_LIMITS.documentBytes ||
      merged.reduce((pixels, resource) => pixels + resource.width * resource.height, 0) >
        IMAGE_LIMITS.documentPixels
    )
      throw new RangeError("Session image resources exceed capacity, including retained history.");
    const additions = merged.slice(this.#resources.length);
    for (const _step of assertImageResourcesSteps(additions, "$.imageResources")) {
      void _step;
      const pending = context.scheduler.checkpoint(undefined, "background");
      if (pending !== undefined) await pending;
    }
    for (const resource of additions) await validateImageResource(resource, context.scheduler);
    if (!context.active()) throw new Error("The document session is unavailable.");
    this.#resources = Object.freeze(merged);
    this.#byId = new Map(merged.map((resource) => [resource.id, resource]));
    this.#changed = true;
  }
}

function captureResource(resource: ImageResourceV3): ImageResourceV3 {
  return canonicalImageResource(resource);
}

function mergeResources(
  current: readonly ImageResourceV3[],
  incoming: readonly ImageResourceV3[],
): ImageResourceV3[] {
  const result = [...current];
  for (const resource of incoming) {
    const existing = result.find((candidate) => candidate.id === resource.id);
    if (existing === undefined) result.push(resource);
    else if (
      existing.data !== resource.data ||
      existing.mimeType !== resource.mimeType ||
      existing.width !== resource.width ||
      existing.height !== resource.height
    )
      throw new RangeError("Conflicting image resource identity.");
  }
  return result;
}

function resourceBytes(resource: ImageResourceV3): number {
  const padding = resource.data.endsWith("==") ? 2 : resource.data.endsWith("=") ? 1 : 0;
  return (resource.data.length / 4) * 3 - padding;
}
