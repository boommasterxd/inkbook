import type { FontResourceV2, InkSnapshotV1 } from "../../../domain/schema/public";
import { assertFontResourcesSteps } from "../../../domain/schema/font-resource-validation";
import type { EditableDocumentModel } from "./document-model-port";
import { DocumentRevisionExhaustedError } from "./document-model-port";
import type { AutosaveCoordinator } from "../../../persistence/saving/autosave/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { validateFontResource } from "../../../persistence/fonts/font-resources";

/** Session-owned immutable resources; output pruning belongs to persistence. */
export class SessionFontResources {
  #resources: readonly FontResourceV2[];
  #version: 1 | 2;
  #pending: Promise<void> = Promise.resolve();

  constructor(snapshot: InkSnapshotV1) {
    this.#version = snapshot.version;
    this.#resources = Object.freeze((snapshot.fontResources ?? []).map(captureResource));
  }

  get resources(): readonly FontResourceV2[] {
    return this.#resources;
  }

  get version(): 1 | 2 {
    return this.#version;
  }

  ensure(
    resources: readonly FontResourceV2[],
    context: {
      readonly active: () => boolean;
      readonly scheduler: WorkScheduler;
      readonly commit: (resources: readonly FontResourceV2[]) => void;
    },
  ): Promise<void> {
    if (resources.length > 64) return Promise.reject(new RangeError("Too many font resources."));
    const captured = resources.map(captureResource);
    const operation = this.#pending.then(async () => {
      if (!context.active()) throw new Error("The document session is unavailable.");
      const merged = mergeResources(this.#resources, captured);
      if (merged.length === this.#resources.length) return;
      if (
        merged.length > 64 ||
        merged.reduce((bytes, font) => bytes + font.data.length, 0) > 32 * 1024 * 1024
      ) {
        throw new RangeError("Document font resources exceed limits.");
      }
      const additions = merged.slice(this.#resources.length);
      for (const _step of assertFontResourcesSteps(additions, "$.fontResources")) {
        void _step;
        const pending = context.scheduler.checkpoint(undefined, "background");
        if (pending !== undefined) await pending;
      }
      for (const resource of additions) {
        await validateFontResource(resource, context.scheduler);
      }
      if (!context.active()) throw new Error("The document session is unavailable.");
      const previous = this.#resources;
      const previousVersion = this.#version;
      this.#resources = Object.freeze(merged);
      this.#version = 2;
      try {
        context.commit(this.#resources);
      } catch (error) {
        this.#resources = previous;
        this.#version = previousVersion;
        throw error;
      }
    });
    this.#pending = operation.catch(() => undefined);
    return operation;
  }
}

function captureResource(resource: FontResourceV2): FontResourceV2 {
  return Object.freeze({
    ...resource,
    ...(resource.weightRange === undefined
      ? {}
      : { weightRange: Object.freeze([...resource.weightRange]) as unknown as [number, number] }),
  });
}

function mergeResources(
  current: readonly FontResourceV2[],
  incoming: readonly FontResourceV2[],
): FontResourceV2[] {
  const result = [...current];
  for (const resource of incoming) {
    const existing = result.find((candidate) => candidate.id === resource.id);
    if (existing !== undefined) {
      if (!sameResource(existing, resource)) throw new RangeError("Conflicting font identity.");
      continue;
    }
    if (result.some((candidate) => sameFace(candidate, resource))) {
      throw new RangeError("Conflicting font face.");
    }
    result.push(resource);
  }
  return result;
}

function sameFace(left: FontResourceV2, right: FontResourceV2): boolean {
  return (
    left.family === right.family &&
    left.style === right.style &&
    Math.max(left.weightRange?.[0] ?? left.weight, right.weightRange?.[0] ?? right.weight) <=
      Math.min(left.weightRange?.[1] ?? left.weight, right.weightRange?.[1] ?? right.weight)
  );
}

function sameResource(left: FontResourceV2, right: FontResourceV2): boolean {
  return (
    left.family === right.family &&
    left.style === right.style &&
    left.weight === right.weight &&
    left.mimeType === right.mimeType &&
    left.data === right.data &&
    left.license === right.license &&
    left.weightRange?.[0] === right.weightRange?.[0] &&
    left.weightRange?.[1] === right.weightRange?.[1]
  );
}

export function ensureSessionFontResources(options: {
  readonly fonts: SessionFontResources;
  readonly resources: readonly FontResourceV2[];
  readonly active: () => boolean;
  readonly scheduler: WorkScheduler;
  readonly revision: () => number;
  readonly setRevision: (revision: number) => void;
  readonly autosave: () => AutosaveCoordinator | undefined;
}): Promise<void> {
  return options.fonts.ensure(options.resources, {
    active: options.active,
    scheduler: options.scheduler,
    commit: (fontResources) => {
      const revision = options.revision();
      if (revision >= Number.MAX_SAFE_INTEGER) throw new DocumentRevisionExhaustedError();
      const autosave = options.autosave();
      if (autosave === undefined) throw new Error("The document session is unavailable.");
      options.setRevision(revision + 1);
      autosave.recordCommit({ modelRevision: revision + 1, fontResources });
    },
  });
}

export function materializeSessionSnapshot(
  model: EditableDocumentModel | undefined,
  revision: number,
): InkSnapshotV1 | undefined {
  return model?.store.materializeSnapshot({
    page: model.page,
    revision,
    version: model.formatVersion ?? 1,
    ...(model.fontResources === undefined ? {} : { fontResources: [...model.fontResources] }),
  });
}
