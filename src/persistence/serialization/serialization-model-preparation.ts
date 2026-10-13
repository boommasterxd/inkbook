import type {
  InkElementV1,
  InkSnapshotV1,
  PageV1,
  SnapshotValidationDerivations,
} from "../../domain/schema/public";
import {
  validateInkSnapshotV1Steps,
  validateRuntimeInkSnapshotV1Steps,
} from "../../domain/schema/snapshot-validation";
import { canonicalElement, canonicalPage } from "./canonical-snapshot";
import { codecFailure, invalidSnapshot } from "./codec-failure";
import {
  renderBandOf as elementRenderBand,
  type RenderBand,
} from "../../domain/commands/render-bands";
import * as facts from "./incremental-validation";
import type { DocumentCodecResult } from "./types";
import {
  captureSnapshotInputSteps,
  copySerializationElementsSteps,
} from "./serialization-input-preparation";
import { toValidationError } from "../../domain/schema/validation-internals";
import { prepareSerializationRanks, type SerializationRanks } from "./serialization-selection";

export interface PreparedSerializationModel {
  readonly elements: Map<string, InkElementV1>;
  readonly facts: Map<string, facts.ElementFacts>;
  readonly aggregate: facts.AggregateFacts;
  readonly orders: Record<RenderBand, string[]>;
  readonly ranks: SerializationRanks;
  readonly page: PageV1;
  readonly revision: number;
  readonly runtimeStrokeBuffers: boolean;
}

export interface SerializationModelPreparationOptions {
  readonly runtimeStrokeBuffers: boolean;
  readonly ownsRuntimeSamples: boolean;
  readonly derivations?: SnapshotValidationDerivations;
  readonly nodesPerStep?: number;
}

/** Prepare all records and derived facts without mutating the current serializer or its caches. */
export function* prepareSerializationModelSteps(
  snapshot: InkSnapshotV1,
  options: SerializationModelPreparationOptions,
): Generator<void, DocumentCodecResult<PreparedSerializationModel>> {
  const nodesPerStep = options.nodesPerStep ?? 256;
  if (options.runtimeStrokeBuffers && !options.ownsRuntimeSamples) {
    try {
      const header = yield* captureSnapshotInputSteps(snapshot);
      snapshot = { ...header, elements: yield* copySerializationElementsSteps(header.elements) };
    } catch (error) {
      return invalidSnapshot(toValidationError(error));
    }
  }
  let derivations = options.derivations;
  if (derivations === undefined) {
    const validation = yield* options.runtimeStrokeBuffers
      ? validateRuntimeInkSnapshotV1Steps(snapshot)
      : validateInkSnapshotV1Steps(snapshot);
    if (!validation.ok) return invalidSnapshot(validation.error);
    snapshot = validation.value;
    derivations = validation.derivations;
  }
  if (derivations.elements.length !== snapshot.elements.length)
    return codecFailure("invalid-delta", "Validated element derivations are incomplete.");
  const elements = new Map<string, InkElementV1>();
  const elementFacts = new Map<string, facts.ElementFacts>();
  const orders: Record<RenderBand, string[]> = { content: [], highlight: [] };
  try {
    for (let index = 0; index < snapshot.elements.length; index += 1) {
      const element = canonicalElement(snapshot.elements[index]!, options.runtimeStrokeBuffers);
      const derived = yield* facts.elementFactsSteps(
        element,
        derivations.elements[index],
        nodesPerStep,
      );
      elements.set(element.id, element);
      elementFacts.set(element.id, derived);
      orders[elementRenderBand(element)].push(element.id);
      if ((index + 1) % nodesPerStep === 0) yield;
    }
  } catch {
    return codecFailure("invalid-delta", "Validated element derivation is inconsistent.");
  }
  const aggregate = yield* facts.aggregateElementFactsSteps(elementFacts.values(), nodesPerStep);
  return {
    ok: true,
    value: {
      elements,
      facts: elementFacts,
      aggregate,
      orders,
      ranks: yield* prepareSerializationRanks(orders, nodesPerStep),
      page: canonicalPage(snapshot.page),
      revision: snapshot.revision,
      runtimeStrokeBuffers: options.runtimeStrokeBuffers,
    },
  };
}

/** Yield markers are only opportunities to consult the injected scheduler, never handoff quotas. */
export async function consumeSerializationSteps<T>(
  steps: Generator<unknown, T>,
  context: { readonly signal?: AbortSignal; checkpoint?(): Promise<void> | undefined },
): Promise<T> {
  try {
    for (;;) {
      context.signal?.throwIfAborted();
      const step = steps.next();
      if (step.done) return step.value;
      const pending = context.checkpoint?.();
      if (pending !== undefined) await pending;
    }
  } finally {
    steps.return(undefined as T);
  }
}

export function completeSerializationSteps<T>(steps: Generator<unknown, T>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}
