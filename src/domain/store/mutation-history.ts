import { DEFAULT_HISTORY_BYTE_LIMIT } from "../commands/history";
import { retainBandSnapshot } from "./band-snapshots";
import type { RenderBand } from "../commands/render-bands";
import type { InkElementV1 } from "../schema/public";
import { mutableElementSteps } from "./immutability";
import { elementMutationPayloadBytes } from "./mutation-payload";
import type { MutationPreparationScheduler } from "./mutation-preparation-scheduler";
import { requireElementRecord } from "./record-access";
import type {
  AppliedElementMutation,
  AppliedRetainedElementMutation,
  ElementMutation,
  ElementRecord,
  RetainedElementMutation,
} from "./types";

interface HistorySource {
  readonly bands: Readonly<Record<RenderBand, readonly string[]>>;
  readonly records: ReadonlyMap<string, ElementRecord>;
}

interface HistoryPreparation {
  readonly requested: ElementMutation;
  readonly source: HistorySource;
  readonly desired: ReadonlyMap<string, InkElementV1>;
  readonly removeIds: ReadonlySet<string>;
  readonly dirtyBands?: Readonly<Record<RenderBand, boolean>>;
  readonly ownedPayloadBytes?: number;
  readonly retainedReplay?: boolean;
  readonly retainedOnly?: boolean;
}

const retainedDirections = new WeakSet<ElementMutation>();

export function isRetainedMutationDirection(mutation: ElementMutation): boolean {
  return retainedDirections.has(mutation);
}

export async function prepareMutationHistory(
  state: HistoryPreparation,
  scheduler: MutationPreparationScheduler,
  replay?: AppliedElementMutation,
  trustedRemoval = false,
): Promise<AppliedElementMutation | "cancelled"> {
  if (replay !== undefined) {
    if (state.retainedReplay) return replay;
    const forwardBytes = await estimateMutationBytes(state.requested, scheduler);
    if (forwardBytes === "cancelled") return forwardBytes;
    const reverseBytes = await estimateReverseBytes(state, scheduler);
    if (reverseBytes === "cancelled") return reverseBytes;
    assertPayloadLimit(forwardBytes + reverseBytes + (state.ownedPayloadBytes ?? 0));
    return replay;
  }
  if (state.retainedOnly) return retainedMutationHistory(state);
  const forward = trustedRemoval
    ? state.requested
    : await freezeMutation(state.requested, scheduler);
  if (forward === "cancelled") return forward;
  const reverse = await reverseMutation(state, forward, scheduler);
  if (reverse === "cancelled") return reverse;
  const forwardBytes = await estimateMutationBytes(forward, scheduler);
  if (forwardBytes === "cancelled") return forwardBytes;
  const reverseBytes = await estimateMutationBytes(reverse, scheduler);
  if (reverseBytes === "cancelled") return reverseBytes;
  const payloadBytes = forwardBytes + reverseBytes + (state.ownedPayloadBytes ?? 0);
  assertPayloadLimit(payloadBytes);
  return Object.freeze({ forward, payloadBytes, reverse });
}

function retainedMutationHistory(state: HistoryPreparation): AppliedRetainedElementMutation {
  const direction = (bands: ElementMutation["bands"]): RetainedElementMutation => {
    const mutation = Object.freeze({
      bands: Object.freeze({
        content: retainBandSnapshot(bands.content),
        highlight: retainBandSnapshot(bands.highlight),
      }),
    }) as RetainedElementMutation;
    retainedDirections.add(mutation);
    return mutation;
  };
  const forward = direction(state.requested.bands);
  const reverse = direction(state.source.bands);
  const payloadBytes =
    (forward.bands.content.length +
      forward.bands.highlight.length +
      reverse.bands.content.length +
      reverse.bands.highlight.length) *
      80 +
    (state.ownedPayloadBytes ?? 0);
  assertPayloadLimit(payloadBytes);
  return Object.freeze({ forward, reverse, payloadBytes, retainedOnly: true });
}

function assertPayloadLimit(bytes: number): void {
  if (bytes > DEFAULT_HISTORY_BYTE_LIMIT) {
    throw new RangeError("Element mutation exceeds the retained history payload limit.");
  }
}

async function estimateReverseBytes(
  { source, desired, removeIds }: HistoryPreparation,
  scheduler: MutationPreparationScheduler,
): Promise<number | "cancelled"> {
  let bytes = (source.bands.content.length + source.bands.highlight.length) * 80;
  for (const id of removeIds) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    bytes += elementMutationPayloadBytes(requireElementRecord(source.records, id).element);
  }
  for (const id of desired.keys()) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    const record = source.records.get(id);
    bytes += record === undefined ? id.length * 2 : elementMutationPayloadBytes(record.element);
  }
  return bytes;
}

async function reverseMutation(
  { source, desired, removeIds, requested, dirtyBands }: HistoryPreparation,
  forward: ElementMutation,
  scheduler: MutationPreparationScheduler,
): Promise<ElementMutation | "cancelled"> {
  const elements: InkElementV1[] = [];
  const removedCreatedIds: string[] = [];
  for (const id of removeIds) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    elements.push(requireElementRecord(source.records, id).element as InkElementV1);
  }
  for (const id of desired.keys()) {
    const current = source.records.get(id);
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    if (current === undefined) removedCreatedIds.push(id);
    else elements.push(current.element as InkElementV1);
  }
  const reusableBands: Partial<Record<RenderBand, readonly string[]>> = {};
  for (const band of ["highlight", "content"] as const) {
    if (dirtyBands?.[band] === false || requested.bands[band] === source.bands[band]) {
      reusableBands[band] = forward.bands[band];
    } else {
      reusableBands[band] = retainBandSnapshot(source.bands[band]);
    }
  }
  return freezeMutation(
    { bands: source.bands, elements, removeIds: removedCreatedIds },
    scheduler,
    reusableBands,
  );
}

async function freezeMutation(
  mutation: ElementMutation,
  scheduler: MutationPreparationScheduler,
  reusableBands: Readonly<Partial<Record<RenderBand, readonly string[]>>> = {},
): Promise<ElementMutation | "cancelled"> {
  const content = reusableBands.content ?? (await copyFrozen(mutation.bands.content, scheduler));
  if (content === "cancelled") return content;
  const highlight =
    reusableBands.highlight ?? (await copyFrozen(mutation.bands.highlight, scheduler));
  if (highlight === "cancelled") return highlight;
  const elements = await copyHistoryElements(mutation.elements ?? [], scheduler);
  if (elements === "cancelled") return elements;
  const removeIds = await copyFrozen(mutation.removeIds ?? [], scheduler);
  if (removeIds === "cancelled") return removeIds;
  return Object.freeze({
    bands: Object.freeze({ content, highlight }),
    elements,
    removeIds,
  });
}

async function copyHistoryElements(
  elements: readonly InkElementV1[],
  scheduler: MutationPreparationScheduler,
): Promise<readonly InkElementV1[] | "cancelled"> {
  const copy = new Array<InkElementV1>(elements.length);
  for (let index = 0; index < elements.length; index += 1) {
    const pendingElement = scheduler.run(mutableElementSteps(elements[index]!));
    const element = pendingElement instanceof Promise ? await pendingElement : pendingElement;
    if (element === "cancelled") return element;
    copy[index] = element;
  }
  return Object.freeze(copy);
}

async function copyFrozen<T>(
  values: readonly T[],
  scheduler: MutationPreparationScheduler,
): Promise<readonly T[] | "cancelled"> {
  const copy = new Array<T>(values.length);
  for (let index = 0; index < values.length; index += 1) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    copy[index] = values[index]!;
  }
  return Object.freeze(copy);
}

async function estimateMutationBytes(
  mutation: ElementMutation,
  scheduler: MutationPreparationScheduler,
): Promise<number | "cancelled"> {
  let bytes = (mutation.bands.content.length + mutation.bands.highlight.length) * 80;
  for (const id of mutation.removeIds ?? []) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    bytes += id.length * 2;
  }
  for (const element of mutation.elements ?? []) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    bytes += elementMutationPayloadBytes(element);
  }
  return bytes;
}
