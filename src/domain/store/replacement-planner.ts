import { renderBandOf } from "../commands/render-bands";
import {
  inferStoredStrokeTranslation,
  isValidatedInternalStyleReplacement,
} from "../elements/stroke-replacement-proof";
import { validateRuntimeReplacement } from "../elements/runtime-replacement-validation";
import type { InkElementV1 } from "../schema/public";
import { validateInkElementV1 } from "../schema/public";

import {
  assertAcyclicConnections,
  assertResolvedConnections,
  isAnchorTarget,
  isConnectable,
  resolveConnections,
} from "./connections";
import {
  classifyReplacement,
  classifyReplacementSteps,
  elementsEqual,
  elementsEqualSteps,
} from "./element-comparison";
import { MutationPreparationScheduler } from "./mutation-preparation-scheduler";
import { prepareRuntimeElement } from "./runtime-element-preparation";
import { cancelled, yieldWhenRequested } from "./replacement-scheduler";
import type {
  DeltaDomain,
  ElementRecord,
  EndpointReference,
  ImmutableInkElement,
  StoreSliceScheduler,
} from "./types";

export interface ReplacementCandidate {
  readonly current: ElementRecord;
  readonly domains: readonly DeltaDomain[];
  readonly element: InkElementV1;
  readonly retainedRecord?: ElementRecord | undefined;
  readonly owned?: boolean;
}

const CANONICAL_TRANSLATION_DOMAINS = Object.freeze(["geometry"] as const);

export interface ReplacementPlannerPorts {
  readonly getRecord: (id: string) => ElementRecord;
  readonly getReferences: (targetId: string) => readonly EndpointReference[] | undefined;
  readonly onReverseVisit: () => void;
  readonly getRetainedRecord?: ((element: InkElementV1) => ElementRecord | undefined) | undefined;
}

export interface TimeSlicedReplacementCandidates {
  readonly candidates: readonly ReplacementCandidate[];
  readonly drafts: ReadonlyMap<string, InkElementV1>;
  readonly yields: number;
}

export function prepareReplacementCandidates(
  replacements: readonly InkElementV1[],
  ports: ReplacementPlannerPorts,
): ReplacementCandidate[] {
  const retained = new Map<string, ElementRecord>();
  const drafts = prepareReplacementDrafts(replacements, ports, retained);
  return classifyReplacementDrafts(drafts, ports.getRecord, retained);
}

export async function prepareReplacementCandidatesTimeSliced(
  replacements: readonly InkElementV1[],
  ports: ReplacementPlannerPorts,
  scheduler: StoreSliceScheduler,
): Promise<TimeSlicedReplacementCandidates | "cancelled"> {
  let yields = 0;
  const trackedScheduler: StoreSliceScheduler = {
    ...scheduler,
    yieldControl: async () => {
      await scheduler.yieldControl();
      yields += 1;
    },
  };
  const retained = new Map<string, ElementRecord>();
  const prepared = await prepareReplacementDraftsTimeSliced(
    replacements,
    ports,
    trackedScheduler,
    retained,
  );
  if (prepared === "cancelled") return prepared;
  const classified = await classifyReplacementDraftsTimeSliced(
    prepared,
    ports.getRecord,
    trackedScheduler,
    retained,
  );
  if (classified === "cancelled") return classified;
  return {
    candidates: classified,
    drafts: prepared,
    yields,
  };
}

export function prepareReplacementDrafts(
  replacements: readonly InkElementV1[],
  ports: ReplacementPlannerPorts,
  retained = new Map<string, ElementRecord>(),
): Map<string, InkElementV1> {
  const drafts = prepareDrafts(replacements, ports, retained);
  propagateTargetChanges(drafts, ports);
  return drafts;
}

async function prepareReplacementDraftsTimeSliced(
  replacements: readonly InkElementV1[],
  ports: ReplacementPlannerPorts,
  scheduler: StoreSliceScheduler,
  retained: Map<string, ElementRecord>,
): Promise<Map<string, InkElementV1> | "cancelled"> {
  const drafts = new Map<string, InkElementV1>();
  const work = new MutationPreparationScheduler(scheduler);
  for (const replacement of replacements) {
    if (cancelled(scheduler)) return "cancelled";
    const owned = ports.getRetainedRecord?.(replacement);
    const current = ports.getRecord(replacement.id);
    const preparation = prepareDraftTimeSliced(replacement, current, work, owned);
    const staged = preparation instanceof Promise ? await preparation : preparation;
    if (staged === "cancelled") return staged;
    assertReplacementIdentity(current.element, staged);
    if (drafts.has(staged.id)) throw new RangeError(`Duplicate replacement ID: ${staged.id}`);
    drafts.set(staged.id, staged);
    if (owned !== undefined) retained.set(staged.id, owned);
    if (!(work.checkpoint() || (await work.resume()))) return "cancelled";
  }
  const lookup = createLookup(drafts, ports.getRecord);
  const connectionRoots: string[] = [];
  for (const [id, draft] of drafts) {
    if (cancelled(scheduler)) return "cancelled";
    if (isConnectable(draft)) {
      drafts.set(id, resolveConnections(draft, lookup));
      connectionRoots.push(id);
    }
    if (!(work.checkpoint() || (await work.resume()))) return "cancelled";
  }
  assertAcyclicConnections(connectionRoots, lookup);
  const propagation = await propagateTargetChangesTimeSliced(drafts, ports, scheduler);
  if (propagation === "cancelled") return propagation;
  return drafts;
}

function prepareDraftTimeSliced(
  replacement: InkElementV1,
  current: ElementRecord,
  work: MutationPreparationScheduler,
  retained: ElementRecord | undefined,
): InkElementV1 | "cancelled" | Promise<InkElementV1 | "cancelled"> {
  return retained?.element === replacement ||
    isCanonicalStrokeTranslation(current.element, replacement) ||
    isValidatedInternalStyleReplacement(current.element, replacement)
    ? replacement
    : prepareRuntimeElement(replacement, current, retained, work);
}

function prepareDrafts(
  replacements: readonly InkElementV1[],
  ports: ReplacementPlannerPorts,
  retained: Map<string, ElementRecord>,
): Map<string, InkElementV1> {
  const drafts = new Map<string, InkElementV1>();
  for (const replacement of replacements) {
    const owned = ports.getRetainedRecord?.(replacement);
    prepareDraft(drafts, replacement, ports.getRecord, owned);
    if (owned !== undefined) retained.set(replacement.id, owned);
  }
  const lookup = createLookup(drafts, ports.getRecord);
  const connectionRoots: string[] = [];
  for (const [id, draft] of drafts) {
    if (isConnectable(draft)) {
      drafts.set(id, resolveConnections(draft, lookup));
      connectionRoots.push(id);
    }
  }
  assertAcyclicConnections(connectionRoots, lookup);
  return drafts;
}

function prepareDraft(
  drafts: Map<string, InkElementV1>,
  replacement: InkElementV1,
  getRecord: (id: string) => ElementRecord,
  retained: ElementRecord | undefined,
): void {
  const current = getRecord(replacement.id);
  assertReplacementIdentity(current.element, replacement);
  if (retained === undefined && !isCanonicalStrokeTranslation(current.element, replacement)) {
    assertValidReplacementElement(current.element, replacement);
  }
  if (drafts.has(replacement.id)) {
    throw new RangeError(`Duplicate replacement ID: ${replacement.id}`);
  }
  drafts.set(replacement.id, replacement);
}

function propagateTargetChanges(
  drafts: Map<string, InkElementV1>,
  ports: ReplacementPlannerPorts,
): void {
  const lookup = createLookup(drafts, ports.getRecord);
  const queue = [...drafts.keys()];
  const queued = new Set(queue);
  const state = { drafts, lookup, ports, queue, queued };
  for (let index = 0; index < queue.length; index += 1) {
    const targetId = queue[index]!;
    queued.delete(targetId);
    const references = changedTargetReferences(targetId, drafts, ports);
    for (const reference of references) propagateReference(reference, state);
  }
}

async function propagateTargetChangesTimeSliced(
  drafts: Map<string, InkElementV1>,
  ports: ReplacementPlannerPorts,
  scheduler: StoreSliceScheduler,
): Promise<number | "cancelled"> {
  const lookup = createLookup(drafts, ports.getRecord);
  const queue = [...drafts.keys()];
  const queued = new Set(queue);
  let yields = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const targetId = queue[index]!;
    queued.delete(targetId);
    if (cancelled(scheduler)) return "cancelled";
    const references = changedTargetReferences(targetId, drafts, ports);
    for (const reference of references) {
      if (cancelled(scheduler)) return "cancelled";
      propagateReference(reference, { drafts, lookup, ports, queue, queued });
      const referenceCheckpoint = yieldWhenRequested(scheduler);
      if (referenceCheckpoint === "cancelled") return referenceCheckpoint;
      if (referenceCheckpoint !== 0) {
        const yielded = await referenceCheckpoint;
        if (yielded === "cancelled") return yielded;
        yields += yielded;
      }
    }
    const checkpoint = yieldWhenRequested(scheduler);
    if (checkpoint === "cancelled") return checkpoint;
    if (checkpoint !== 0) {
      const yielded = await checkpoint;
      if (yielded === "cancelled") return yielded;
      yields += yielded;
    }
  }
  return yields;
}

interface PropagationState {
  readonly drafts: Map<string, InkElementV1>;
  readonly lookup: (id: string) => ImmutableInkElement | InkElementV1 | undefined;
  readonly ports: ReplacementPlannerPorts;
  readonly queue: string[];
  readonly queued: Set<string>;
}

function changedTargetReferences(
  targetId: string,
  drafts: ReadonlyMap<string, InkElementV1>,
  ports: ReplacementPlannerPorts,
): readonly EndpointReference[] {
  const draft = drafts.get(targetId);
  if (draft === undefined) return [];
  const current = ports.getRecord(targetId);
  return isGeometryTargetChange(current.element, draft)
    ? (ports.getReferences(targetId) ?? [])
    : [];
}

function propagateReference(reference: EndpointReference, state: PropagationState): void {
  state.ports.onReverseVisit();
  const source =
    state.drafts.get(reference.linearId) ?? state.ports.getRecord(reference.linearId).element;
  const resolved = resolveConnections(source, state.lookup, "detach");
  if (elementsEqual(source, resolved)) return;
  state.drafts.set(reference.linearId, resolved);
  if (state.queued.has(reference.linearId)) return;
  state.queue.push(reference.linearId);
  state.queued.add(reference.linearId);
}

export function classifyReplacementDrafts(
  drafts: Map<string, InkElementV1>,
  getRecord: (id: string) => ElementRecord,
  retained: ReadonlyMap<string, ElementRecord> = new Map(),
): ReplacementCandidate[] {
  const candidates: ReplacementCandidate[] = [];
  const lookup = createLookup(drafts, getRecord);
  for (const [id, element] of drafts) {
    const candidate = classifyCandidate(id, element, getRecord, lookup, retained.get(id));
    if (candidate !== null) candidates.push(candidate);
  }
  return candidates;
}

async function classifyReplacementDraftsTimeSliced(
  drafts: Map<string, InkElementV1>,
  getRecord: (id: string) => ElementRecord,
  scheduler: StoreSliceScheduler,
  retained: ReadonlyMap<string, ElementRecord>,
): Promise<readonly ReplacementCandidate[] | "cancelled"> {
  const candidates: ReplacementCandidate[] = [];
  const lookup = createLookup(drafts, getRecord);
  const work = new MutationPreparationScheduler(scheduler);
  for (const [id, element] of drafts) {
    if (cancelled(scheduler)) return "cancelled";
    const classification = classifyCandidateTimeSliced(
      getRecord(id),
      element,
      lookup,
      work,
      retained.get(id),
    );
    const candidate = classification instanceof Promise ? await classification : classification;
    if (candidate === "cancelled") return candidate;
    if (candidate !== null) candidates.push(candidate);
    if (!(work.checkpoint() || (await work.resume()))) return "cancelled";
  }
  return candidates;
}

function classifyCandidateTimeSliced(
  current: ElementRecord,
  element: InkElementV1,
  lookup: (id: string) => ImmutableInkElement | InkElementV1 | undefined,
  work: MutationPreparationScheduler,
  retainedRecord: ElementRecord | undefined,
): ReplacementCandidate | null | "cancelled" | Promise<ReplacementCandidate | null | "cancelled"> {
  const translation = canonicalStrokeTranslation(current.element, element);
  if (translation !== null) {
    return translation.x === 0 && translation.y === 0
      ? null
      : { current, domains: CANONICAL_TRANSLATION_DOMAINS, element, retainedRecord };
  }
  return work.run(classifyCandidateSteps(current, element, lookup, retainedRecord));
}

function* classifyCandidateSteps(
  current: ElementRecord,
  element: InkElementV1,
  lookup: (id: string) => ImmutableInkElement | InkElementV1 | undefined,
  retainedRecord: ElementRecord | undefined,
): Generator<void | boolean, ReplacementCandidate | null> {
  const equal = yield* elementsEqualSteps(current.element, element);
  if (equal) return null;
  yield;
  const domains = yield* classifyReplacementSteps(current.element, element);
  return classifiedCandidate(current, element, domains, lookup, retainedRecord);
}

function classifyCandidate(
  id: string,
  element: InkElementV1,
  getRecord: (id: string) => ElementRecord,
  lookup: (id: string) => ImmutableInkElement | InkElementV1 | undefined,
  retainedRecord: ElementRecord | undefined,
): ReplacementCandidate | null {
  const current = getRecord(id);
  const translation = canonicalStrokeTranslation(current.element, element);
  if (translation !== null) {
    return translation.x === 0 && translation.y === 0
      ? null
      : { current, domains: CANONICAL_TRANSLATION_DOMAINS, element, retainedRecord };
  }
  if (elementsEqual(current.element, element)) return null;
  const domains = classifyReplacement(current.element, element);
  return classifiedCandidate(current, element, domains, lookup, retainedRecord);
}

function classifiedCandidate(
  current: ElementRecord,
  element: InkElementV1,
  domains: DeltaDomain[],
  lookup: (id: string) => ImmutableInkElement | InkElementV1 | undefined,
  retainedRecord: ElementRecord | undefined,
): ReplacementCandidate {
  if (domains.length === 0) throw new RangeError("Replacement changed unsupported record fields.");
  if (isConnectable(element)) assertValidReplacementElement(current.element, element);
  assertResolvedConnections(element, lookup);
  return { current, domains: Object.freeze(domains), element, retainedRecord };
}

function isCanonicalStrokeTranslation(
  current: ImmutableInkElement,
  replacement: InkElementV1,
): boolean {
  return canonicalStrokeTranslation(current, replacement) !== null;
}

function canonicalStrokeTranslation(
  current: ImmutableInkElement,
  replacement: InkElementV1,
): Readonly<{ x: number; y: number }> | null {
  if (current.kind !== "stroke" || replacement.kind !== "stroke") return null;
  const proof = inferStoredStrokeTranslation(current, replacement);
  return proof?.source === current ? proof.translation : null;
}

function createLookup(
  drafts: ReadonlyMap<string, InkElementV1>,
  getRecord: (id: string) => ElementRecord,
): (id: string) => ImmutableInkElement | InkElementV1 | undefined {
  return (id) => drafts.get(id) ?? getOptionalRecord(getRecord, id)?.element;
}

function getOptionalRecord(
  getRecord: (id: string) => ElementRecord,
  id: string,
): ElementRecord | undefined {
  try {
    return getRecord(id);
  } catch {
    return undefined;
  }
}

function isGeometryTargetChange(current: ImmutableInkElement, draft: InkElementV1): boolean {
  if (current.kind === "table" && draft.kind === "table" && tableAnchorFrameEqual(current, draft)) {
    return false;
  }
  return isAnchorTarget(draft) && classifyReplacement(current, draft).includes("geometry");
}

function tableAnchorFrameEqual(
  current: Extract<ImmutableInkElement, { kind: "table" }>,
  draft: Extract<InkElementV1, { kind: "table" }>,
): boolean {
  return (
    current.x === draft.x &&
    current.y === draft.y &&
    current.columnWidth === draft.columnWidth &&
    current.columns === draft.columns &&
    current.height === draft.height &&
    current.rotation === draft.rotation &&
    current.pivot.x === draft.pivot.x &&
    current.pivot.y === draft.pivot.y
  );
}

export function assertReplacementIdentity(
  current: ImmutableInkElement,
  replacement: InkElementV1,
): void {
  if (
    current.id !== replacement.id ||
    current.kind !== replacement.kind ||
    current.createdAt !== replacement.createdAt ||
    renderBandOf(current) !== renderBandOf(replacement)
  ) {
    throw new RangeError(
      "Replacement identity, kind, creation time, and render band are immutable.",
    );
  }
}

export function assertValidElement(element: InkElementV1): void {
  const result = validateInkElementV1(element);
  if (!result.ok) throw new RangeError(`Invalid element replacement: ${result.error.code}`);
}

export function assertValidReplacementElement(
  current: ImmutableInkElement,
  replacement: InkElementV1,
): void {
  if (isValidatedInternalStyleReplacement(current, replacement)) return;
  const isOwnedRuntimeStroke =
    current.kind === "stroke" &&
    current.points instanceof Float64Array &&
    replacement.kind === "stroke" &&
    replacement.points instanceof Float64Array;
  const reusesStrokeSamples =
    current.kind === "stroke" &&
    replacement.kind === "stroke" &&
    current.points === replacement.points;
  const result =
    isOwnedRuntimeStroke || reusesStrokeSamples
      ? validateRuntimeReplacement(current, replacement)
      : validateInkElementV1(replacement);
  if (!result.ok) throw new RangeError(`Invalid element replacement: ${result.error.code}`);
}
