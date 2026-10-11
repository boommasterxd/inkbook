import { DEFAULT_HISTORY_BYTE_LIMIT } from "../commands/history";
import type { RenderBand } from "../commands/render-bands";
import type { InkElementV1 } from "../schema/public";
import { mutableElementSteps } from "./immutability";
import { elementMutationPayloadBytes } from "./mutation-payload";
import type { MutationPreparationScheduler } from "./mutation-preparation-scheduler";
import { requireElementRecord } from "./record-access";
import type { AppliedElementMutation, ElementMutation, ElementRecord } from "./types";

interface HistorySource {
  readonly bands: Readonly<Record<RenderBand, readonly string[]>>;
  readonly records: ReadonlyMap<string, ElementRecord>;
}

interface HistoryPreparation {
  readonly requested: ElementMutation;
  readonly source: HistorySource;
  readonly desired: ReadonlyMap<string, InkElementV1>;
  readonly removeIds: ReadonlySet<string>;
  readonly ownedPayloadBytes?: number;
  readonly retainedReplay?: boolean;
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
  const forward = trustedRemoval
    ? state.requested
    : await freezeMutation(state.requested, scheduler);
  if (forward === "cancelled") return forward;
  const reverse = await reverseMutation(state.source, state.desired, state.removeIds, scheduler);
  if (reverse === "cancelled") return reverse;
  const forwardBytes = await estimateMutationBytes(forward, scheduler);
  if (forwardBytes === "cancelled") return forwardBytes;
  const reverseBytes = await estimateMutationBytes(reverse, scheduler);
  if (reverseBytes === "cancelled") return reverseBytes;
  const payloadBytes = forwardBytes + reverseBytes + (state.ownedPayloadBytes ?? 0);
  assertPayloadLimit(payloadBytes);
  return Object.freeze({ forward, payloadBytes, reverse });
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
  source: HistorySource,
  desired: ReadonlyMap<string, InkElementV1>,
  removeIds: ReadonlySet<string>,
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
  return freezeMutation({ bands: source.bands, elements, removeIds: removedCreatedIds }, scheduler);
}

async function freezeMutation(
  mutation: ElementMutation,
  scheduler: MutationPreparationScheduler,
): Promise<ElementMutation | "cancelled"> {
  const content = await copyFrozen(mutation.bands.content, scheduler);
  if (content === "cancelled") return content;
  const highlight = await copyFrozen(mutation.bands.highlight, scheduler);
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
    const element = await scheduler.run(mutableElementSteps(elements[index]!));
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
