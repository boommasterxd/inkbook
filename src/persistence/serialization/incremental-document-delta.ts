import { validateRuntimeReplacement } from "../../domain/elements/runtime-replacement-validation";
import { markStoredStroke } from "../../domain/elements/stroke-replacement-proof";
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
    const elements = [...options.prepared.orders.highlight, ...options.prepared.orders.content].map(
      (id) => options.prepared.changed.get(id) ?? options.currentElements.get(id)!,
    );
    const validation = validateInkConnectionRelationsV1(elements);
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
  if (removed.size === 0 && options.delta.orderChanges === undefined) {
    const unchangedBands = [...changed.values()].every((element) => {
      const current = options.currentElements.get(element.id);
      return current !== undefined && elementRenderBand(current) === elementRenderBand(element);
    });
    if (unchangedBands) return { ok: true, value: options.currentOrders };
  }
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
  if (orders.highlight.length + orders.content.length !== available.size) return false;
  const seen = new Set<string>();
  return (["highlight", "content"] as const).every((band) =>
    orders[band].every((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
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
        ? validateRuntimeChange(options.currentElements.get(element.id), element)
        : validateInkElementV1(element);
      if (!validation.ok) return invalidSnapshot(validation.error);
      changedFacts.set(
        element.id,
        incrementalValidation.validatedDeltaElementFacts(
          element,
          options.prepared.derivations.get(element.id),
          options.currentFacts.get(element.id),
        ),
      );
    }
  } catch {
    return codecFailure("invalid-delta", "Changed element derivation is inconsistent.");
  }
  return { ok: true, value: changedFacts };
}

function validateRuntimeChange(current: InkElementV1 | undefined, replacement: InkElementV1) {
  // Current runtime records passed schema validation and own their transferred sample buffers.
  if (current?.kind === "stroke" && current.points instanceof Float64Array) {
    return validateRuntimeReplacement(markStoredStroke(current), replacement);
  }
  return validateRuntimeInkElementV1(replacement);
}
