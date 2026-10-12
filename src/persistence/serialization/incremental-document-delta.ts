import { validateRuntimeReplacementSteps } from "../../domain/elements/runtime-replacement-validation";
import { markStoredStroke } from "../../domain/elements/stroke-replacement-proof";
import {
  validateInkElementV1,
  validateInkPageV1,
  type ElementValidationDerivation,
  type InkElementV1,
  type PageV1,
} from "../../domain/schema/public";
import {
  validateInkElementV1Steps,
  validateRuntimeInkElementV1,
  validateRuntimeInkElementV1Steps,
} from "../../domain/schema/element-validation";
import { validateInkConnectionRelationsV1Steps } from "../../domain/schema/snapshot-validation";
import { codecFailure, invalidSnapshot } from "./codec-failure";
import { elementRenderBand, type RenderBand } from "./element-fragments";
import * as incrementalValidation from "./incremental-validation";
import type {
  DocumentSerializationDelta,
  PreparedDelta,
} from "./incremental-document-serializer-types";
import type { DocumentCodecResult } from "./types";

interface PrepareDeltaOptions {
  readonly currentElements: ReadonlyMap<string, InkElementV1>;
  readonly currentOrders: Readonly<Record<RenderBand, string[]>>;
  readonly currentPage: PageV1;
  readonly delta: DocumentSerializationDelta;
}

interface ValidateDeltaOptions {
  readonly aggregate: incrementalValidation.AggregateFacts;
  readonly currentElements: ReadonlyMap<string, InkElementV1>;
  readonly currentFacts: ReadonlyMap<string, incrementalValidation.ElementFacts>;
  readonly currentPage: PageV1;
  readonly pageChanged: boolean;
  readonly prepared: PreparedDelta;
  readonly runtimeStrokeBuffers: boolean;
}

export function* prepareDocumentDeltaSteps(
  options: PrepareDeltaOptions,
  nodesPerStep = 256,
): Generator<void, DocumentCodecResult<PreparedDelta>> {
  const { delta } = options;
  if (!Number.isSafeInteger(delta.modelRevision) || delta.modelRevision < 0) {
    return codecFailure(
      "invalid-delta",
      "Delta model revision must be a non-negative safe integer.",
    );
  }
  const removed = new Set<string>();
  let visited = 0;
  for (const id of delta.removedIds ?? []) {
    removed.add(id);
    if (++visited % nodesPerStep === 0) yield;
  }
  if (removed.size !== (delta.removedIds?.length ?? 0)) {
    return codecFailure("invalid-delta", "Removed element IDs must be unique.");
  }
  const changed = yield* prepareChangedElements(delta, removed, nodesPerStep);
  if (!changed.ok) return changed;
  const derivations = yield* prepareDerivations(delta, changed.value, nodesPerStep);
  if (!derivations.ok) return derivations;
  const orders = yield* prepareOrders(options, changed.value, removed, nodesPerStep);
  if (!orders.ok) return orders;
  const page = delta.page ?? options.currentPage;
  if (delta.page !== undefined) {
    const validation = validateInkPageV1(page);
    if (!validation.ok) return invalidSnapshot(validation.error);
  }
  return {
    ok: true,
    value: {
      changed: changed.value,
      derivations: derivations.value,
      orders: orders.value,
      removed,
      page,
    },
  };
}

export function* validateDocumentDeltaSteps(
  options: ValidateDeltaOptions,
  nodesPerStep = 256,
): Generator<boolean | void, DocumentCodecResult<incrementalValidation.ValidatedDeltaFacts>> {
  const changedFacts = yield* validateChangedFacts(options, nodesPerStep);
  if (!changedFacts.ok) return changedFacts;
  const aggregate = yield* incrementalValidation.updateAggregateFactsSteps(
    options.aggregate,
    options.currentFacts,
    changedFacts.value,
    options.prepared.removed,
    nodesPerStep,
  );
  if (
    (options.prepared.changed.size > 0 || options.prepared.removed.size > 0) &&
    (yield* incrementalValidation.connectionRelationsAffectedSteps(
      options.currentElements,
      options.prepared.changed,
      options.prepared.removed,
      nodesPerStep,
    ))
  ) {
    const elements: InkElementV1[] = [];
    let visited = 0;
    for (const band of ["highlight", "content"] as const) {
      for (const id of options.prepared.orders[band]) {
        elements.push(options.prepared.changed.get(id) ?? options.currentElements.get(id)!);
        if (++visited % nodesPerStep === 0) yield;
      }
    }
    const validation = yield* validateInkConnectionRelationsV1Steps(elements);
    if (!validation.ok) return invalidSnapshot(validation.error);
  }
  const aggregateError = incrementalValidation.validateAggregateFacts(
    aggregate,
    options.pageChanged ? options.prepared.page : options.currentPage,
  );
  return aggregateError === null
    ? { ok: true, value: { aggregate, changed: changedFacts.value } }
    : invalidSnapshot(aggregateError);
}

function* prepareChangedElements(
  delta: DocumentSerializationDelta,
  removed: ReadonlySet<string>,
  nodesPerStep: number,
): Generator<void, DocumentCodecResult<ReadonlyMap<string, InkElementV1>>> {
  const changed = new Map<string, InkElementV1>();
  for (const element of delta.changedElements ?? []) {
    if (removed.has(element.id) || changed.has(element.id)) {
      return codecFailure(
        "invalid-delta",
        "Changed and removed element IDs must be disjoint and unique.",
      );
    }
    changed.set(element.id, element);
    if (changed.size % nodesPerStep === 0) yield;
  }
  return { ok: true, value: changed };
}

function* prepareDerivations(
  delta: DocumentSerializationDelta,
  changed: ReadonlyMap<string, InkElementV1>,
  nodesPerStep: number,
): Generator<void, DocumentCodecResult<ReadonlyMap<string, ElementValidationDerivation>>> {
  const derivations = new Map<string, ElementValidationDerivation>();
  for (const derivation of delta.changedElementDerivations ?? []) {
    if (!changed.has(derivation.elementId) || derivations.has(derivation.elementId)) {
      return codecFailure(
        "invalid-delta",
        "Changed element derivations must uniquely match changed elements.",
      );
    }
    derivations.set(derivation.elementId, derivation);
    if (derivations.size % nodesPerStep === 0) yield;
  }
  return { ok: true, value: derivations };
}

function* prepareOrders(
  options: PrepareDeltaOptions,
  changed: ReadonlyMap<string, InkElementV1>,
  removed: ReadonlySet<string>,
  nodesPerStep: number,
): Generator<void, DocumentCodecResult<Record<RenderBand, string[]>>> {
  let visited = 0;
  if (removed.size === 0 && options.delta.orderChanges === undefined) {
    const unchangedBands = yield* keepsCurrentBands(options.currentElements, changed, nodesPerStep);
    if (unchangedBands) return { ok: true, value: options.currentOrders };
  }
  const available = new Map<string, InkElementV1>();
  for (const [id, element] of options.currentElements) {
    available.set(id, element);
    if (++visited % nodesPerStep === 0) yield;
  }
  for (const id of removed) {
    available.delete(id);
    if (++visited % nodesPerStep === 0) yield;
  }
  for (const [id, element] of changed) {
    available.set(id, element);
    if (++visited % nodesPerStep === 0) yield;
  }
  const orders = { content: [] as string[], highlight: [] as string[] };
  for (const band of ["highlight", "content"] as const) {
    const replacement = options.delta.orderChanges?.[band];
    for (const id of replacement ?? options.currentOrders[band]) {
      if (replacement !== undefined || available.has(id)) orders[band].push(id);
      if (++visited % nodesPerStep === 0) yield;
    }
  }
  if (!(yield* hasCompleteValidOrder(orders, available, nodesPerStep))) {
    return codecFailure(
      "invalid-order",
      "Band order must contain every current element ID exactly once.",
    );
  }
  return { ok: true, value: orders };
}

function* keepsCurrentBands(
  currentElements: ReadonlyMap<string, InkElementV1>,
  changed: ReadonlyMap<string, InkElementV1>,
  nodesPerStep: number,
): Generator<void, boolean> {
  let visited = 0;
  for (const element of changed.values()) {
    const current = currentElements.get(element.id);
    if (current === undefined || elementRenderBand(current) !== elementRenderBand(element))
      return false;
    if (++visited % nodesPerStep === 0) yield;
  }
  return true;
}

function* hasCompleteValidOrder(
  orders: Readonly<Record<RenderBand, readonly string[]>>,
  available: ReadonlyMap<string, InkElementV1>,
  nodesPerStep: number,
): Generator<void, boolean> {
  if (orders.highlight.length + orders.content.length !== available.size) return false;
  const seen = new Set<string>();
  for (const band of ["highlight", "content"] as const) {
    for (const id of orders[band]) {
      if (seen.has(id)) return false;
      seen.add(id);
      const element = available.get(id);
      if (element === undefined || elementRenderBand(element) !== band) return false;
      if (seen.size % nodesPerStep === 0) yield;
    }
  }
  return true;
}

function* validateChangedFacts(
  options: ValidateDeltaOptions,
  nodesPerStep: number,
): Generator<
  boolean | void,
  DocumentCodecResult<ReadonlyMap<string, incrementalValidation.ElementFacts>>
> {
  const changedFacts = new Map<string, incrementalValidation.ElementFacts>();
  try {
    for (const element of options.prepared.changed.values()) {
      const validation = options.runtimeStrokeBuffers
        ? yield* validateRuntimeChange(
            options.currentElements.get(element.id),
            element,
            nodesPerStep,
          )
        : Number.isFinite(nodesPerStep)
          ? yield* validateInkElementV1Steps(element, {}, nodesPerStep, nodesPerStep)
          : validateInkElementV1(element);
      if (!validation.ok) return invalidSnapshot(validation.error);
      changedFacts.set(
        element.id,
        yield* incrementalValidation.validatedDeltaElementFactsSteps(
          element,
          options.prepared.derivations.get(element.id),
          options.currentFacts.get(element.id),
          nodesPerStep,
        ),
      );
      if (changedFacts.size % nodesPerStep === 0) yield;
    }
  } catch {
    return codecFailure("invalid-delta", "Changed element derivation is inconsistent.");
  }
  return { ok: true, value: changedFacts };
}

function* validateRuntimeChange(
  current: InkElementV1 | undefined,
  replacement: InkElementV1,
  nodesPerStep: number,
) {
  // Current runtime records passed schema validation and own their transferred sample buffers.
  if (current?.kind === "stroke" && current.points instanceof Float64Array) {
    return yield* validateRuntimeReplacementSteps(
      markStoredStroke(current),
      replacement,
      nodesPerStep,
      nodesPerStep,
    );
  }
  return Number.isFinite(nodesPerStep)
    ? yield* validateRuntimeInkElementV1Steps(replacement, {}, nodesPerStep, nodesPerStep)
    : validateRuntimeInkElementV1(replacement);
}
