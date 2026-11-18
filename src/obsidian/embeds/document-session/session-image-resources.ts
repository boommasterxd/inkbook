import type { ImageResourceV3, InkSnapshotV1 } from "../../../domain/schema/public";
import { ImageResourceBudget } from "../../../domain/images/image-resource-budget";
import { IMAGE_LIMITS } from "../../../domain/images/image-limits";
import { assertImageResourcesSteps } from "../../../domain/schema/image-validation";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import {
  canonicalImageResource,
  validateImageResourceSteps,
} from "../../../persistence/images/image-resources";

export class ImageResourceCapacityError extends RangeError {
  constructor() {
    super("Session image resources exceed capacity, including retained history.");
    this.name = "ImageResourceCapacityError";
  }
}

declare const PREPARED_IMAGE_RESOURCES: unique symbol;
export interface PreparedImageResources {
  readonly [PREPARED_IMAGE_RESOURCES]: true;
}
interface ResourcePreparationContext {
  readonly active: () => boolean;
  readonly scheduler: WorkScheduler;
  readonly isCancelled?: () => boolean;
}

/** Retain admitted assets for the complete session, including undo/redo history. */
export class SessionImageResources {
  #resources: readonly ImageResourceV3[];
  #byId: ReadonlyMap<string, ImageResourceV3>;
  #pending: Promise<void> = Promise.resolve();
  #changed = false;
  readonly #prepared = new WeakMap<PreparedImageResources, readonly ImageResourceV3[]>();

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

  add(resources: readonly ImageResourceV3[], context: ResourcePreparationContext): Promise<void> {
    if (resources.length > IMAGE_LIMITS.resources)
      return Promise.reject(new RangeError("Too many image resources."));
    const captured = Object.freeze(resources.map(captureResource));
    const operation = this.#pending.then(async () => {
      const prepared = await this.#prepare(captured, context);
      if (prepared !== null) this.prepareCommit(prepared)();
    });
    this.#pending = operation.catch(() => undefined);
    return operation;
  }

  /** Validate privately; failed or cancelled element preparation must retain no assets. */
  prepare(
    resources: readonly ImageResourceV3[],
    context: ResourcePreparationContext,
  ): Promise<PreparedImageResources | null> {
    if (resources.length > IMAGE_LIMITS.resources)
      return Promise.reject(new RangeError("Too many image resources."));
    const captured = Object.freeze(resources.map(captureResource));
    return this.#prepare(captured, context);
  }

  async #prepare(
    captured: readonly ImageResourceV3[],
    context: ResourcePreparationContext,
  ): Promise<PreparedImageResources | null> {
    if (this.#cancelled(context)) return null;
    const merged = checkedResources(this.#resources, captured);
    const additions = merged.slice(this.#resources.length);
    if (!(await this.#validate(assertImageResourcesSteps(additions, "$.imageResources"), context)))
      return null;
    for (const resource of additions)
      if (!(await this.#validate(validateImageResourceSteps(resource), context))) return null;
    if (this.#cancelled(context)) return null;
    const token = Object.freeze({}) as PreparedImageResources;
    this.#prepared.set(token, captured);
    return token;
  }

  /** Called immediately before Store commit; the returned hook only swaps prepared state. */
  prepareCommit(token: PreparedImageResources): () => void {
    const resources = this.#prepared.get(token);
    this.#prepared.delete(token);
    if (resources === undefined)
      throw new RangeError("Image preparation is not owned or was used.");
    const merged = checkedResources(this.#resources, resources);
    if (merged.length === this.#resources.length) return () => undefined;
    const captured = Object.freeze(merged);
    const byId = new Map(merged.map((resource) => [resource.id, resource]));
    return () => {
      this.#resources = captured;
      this.#byId = byId;
      this.#changed = true;
    };
  }

  async #validate(steps: Generator<void>, context: ResourcePreparationContext): Promise<boolean> {
    for (const _step of steps) {
      void _step;
      if (this.#cancelled(context)) return false;
      const pending = context.scheduler.checkpoint(undefined, "background");
      if (pending !== undefined) await pending;
    }
    return !this.#cancelled(context);
  }

  #cancelled(context: ResourcePreparationContext): boolean {
    if (!context.active()) throw new Error("The document session is unavailable.");
    return context.isCancelled?.() === true;
  }
}

function checkedResources(
  current: readonly ImageResourceV3[],
  incoming: readonly ImageResourceV3[],
): ImageResourceV3[] {
  const merged = mergeResources(current, incoming);
  const budget = new ImageResourceBudget();
  if (!merged.every((resource) => budget.tryInclude(resource)))
    throw new ImageResourceCapacityError();
  return merged;
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
