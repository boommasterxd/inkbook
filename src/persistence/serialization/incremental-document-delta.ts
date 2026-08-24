import {
  validateInkConnectionRelationsV1,
  validateInkElementV1,
  validateInkPageV1,
  type ElementValidationDerivation,
  type InkElementV1,
  type PageV1,
} from "../../domain/schema/public";
import { validateRuntimeInkElementV1 } from "../../domain/schema/element-validation";
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
  readonly currentOrders: Readonly<Record<RenderBand, readonly string[]>>;
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

export function prepareDocumentDelta(
  options: PrepareDeltaOptions,
): DocumentCodecResult<PreparedDelta> {
  const { delta } = options;
  if (!Number.isSafeInteger(delta.modelRevision) || delta.modelRevision < 0) {
    return codecFailure(
      "invalid-delta",
      "Delta model revision must be a non-negative safe integer.",
    );
  }
  const removed = new Set(delta.removedIds ?? []);
  if (removed.size !== (delta.removedIds?.length ?? 0)) {
    return codecFailure("invalid-delta", "Removed element IDs must be unique.");
  }
  const changed = prepareChangedElements(delta, removed);
  if (!changed.ok) return changed;
  const derivations = prepareDerivations(delta, changed.value);
  if (!derivations.ok) return derivations;
  const orders = prepareOrders(options, changed.value, removed);
  if (!orders.ok) return orders;
  const elements = [...orders.value.highlight, ...orders.value.content].map(
    (id) => changed.value.get(id) ?? options.currentElements.get(id)!,
  );
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
      snapshot: { elements, format: "inkbook", page, revision: delta.modelRevision, version: 1 },
    },
  };
}

export function validateDocumentDelta(
  options: ValidateDeltaOptions,
): DocumentCodecResult<incrementalValidation.ValidatedDeltaFacts> {
  const changedFacts = validateChangedFacts(options);
  if (!changedFacts.ok) return changedFacts;
  const aggregate = incrementalValidation.updateAggregateFacts(
    options.aggregate,
    options.currentFacts,
    changedFacts.value,
    options.prepared.removed,
  );
  if (
    (options.prepared.changed.size > 0 || options.prepared.removed.size > 0) &&
    incrementalValidation.connectionRelationsAffected(
      options.currentElements,
      options.prepared.changed,
      options.prepared.removed,
    )
  ) {
    const validation = validateInkConnectionRelationsV1(options.prepared.snapshot.elements);
    if (!validation.ok) return invalidSnapshot(validation.error);
  }
  const aggregateError = incrementalValidation.validateAggregateFacts(
    aggregate,
    options.pageChanged ? options.prepared.snapshot.page : options.currentPage,
  );
  return aggregateError === null
    ? { ok: true, value: { aggregate, changed: changedFacts.value } }
    : invalidSnapshot(aggregateError);
}

function prepareChangedElements(
  delta: DocumentSerializationDelta,
  removed: ReadonlySet<string>,
): DocumentCodecResult<ReadonlyMap<string, InkElementV1>> {
  const changed = new Map<string, InkElementV1>();
  for (const element of delta.changedElements ?? []) {
    if (removed.has(element.id) || changed.has(element.id)) {
      return codecFailure(
        "invalid-delta",
        "Changed and removed element IDs must be disjoint and unique.",
      );
    }
    changed.set(element.id, element);
  }
  return { ok: true, value: changed };
}

function prepareDerivations(
  delta: DocumentSerializationDelta,
  changed: ReadonlyMap<string, InkElementV1>,
): DocumentCodecResult<ReadonlyMap<string, ElementValidationDerivation>> {
  const derivations = new Map<string, ElementValidationDerivation>();
  for (const derivation of delta.changedElementDerivations ?? []) {
    if (!changed.has(derivation.elementId) || derivations.has(derivation.elementId)) {
      return codecFailure(
        "invalid-delta",
        "Changed element derivations must uniquely match changed elements.",
      );
    }
    derivations.set(derivation.elementId, derivation);
  }
  return { ok: true, value: derivations };
}

function prepareOrders(
  options: PrepareDeltaOptions,
  changed: ReadonlyMap<string, InkElementV1>,
  removed: ReadonlySet<string>,
): DocumentCodecResult<Record<RenderBand, string[]>> {
  const available = new Map(options.currentElements);
  for (const id of removed) available.delete(id);
  for (const [id, element] of changed) available.set(id, element);
  const orders = { content: [] as string[], highlight: [] as string[] };
  for (const band of ["highlight", "content"] as const) {
    orders[band] =
      options.delta.orderChanges?.[band] === undefined
        ? options.currentOrders[band].filter((id) => available.has(id))
        : [...options.delta.orderChanges[band]];
  }
  if (!hasCompleteValidOrder(orders, available)) {
    return codecFailure(
      "invalid-order",
      "Band order must contain every current element ID exactly once.",
    );
  }
  return { ok: true, value: orders };
}

function hasCompleteValidOrder(
  orders: Readonly<Record<RenderBand, readonly string[]>>,
  available: ReadonlyMap<string, InkElementV1>,
): boolean {
  const ordered = [...orders.highlight, ...orders.content];
  if (ordered.length !== available.size || new Set(ordered).size !== ordered.length) return false;
  return (["highlight", "content"] as const).every((band) =>
    orders[band].every((id) => {
      const element = available.get(id);
      return element !== undefined && elementRenderBand(element) === band;
    }),
  );
}

function validateChangedFacts(
  options: ValidateDeltaOptions,
): DocumentCodecResult<ReadonlyMap<string, incrementalValidation.ElementFacts>> {
  const changedFacts = new Map<string, incrementalValidation.ElementFacts>();
  try {
    for (const element of options.prepared.changed.values()) {
      const validation = options.runtimeStrokeBuffers
        ? validateRuntimeInkElementV1(element)
        : validateInkElementV1(element);
      if (!validation.ok) return invalidSnapshot(validation.error);
      changedFacts.set(
        element.id,
        incrementalValidation.validatedDeltaElementFacts(
          element,
          options.prepared.derivations.get(element.id),
        ),
      );
    }
  } catch {
    return codecFailure("invalid-delta", "Changed element derivation is inconsistent.");
  }
  return { ok: true, value: changedFacts };
}
