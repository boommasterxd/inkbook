import { elementMutationPayloadBytes } from "./mutation-payload";
import { classifyReplacementSteps, elementsEqualSteps } from "./element-comparison";
import { assignRecordVersions } from "./record-factory";
import type { InkElementV1 } from "../schema/public";
import type { RenderBand } from "../commands/render-bands";
import type { MutationPreparationScheduler } from "./mutation-preparation-scheduler";
import type { AppliedElementMutation, ElementMutation, ElementRecord, StoreDelta } from "./types";

export interface OwnedMutationHistory {
  readonly forward: ReadonlyMap<string, ElementRecord>;
  readonly reverse: ReadonlyMap<string, ElementRecord>;
  readonly payloadBytes: number;
  readonly dirtyBands: Readonly<Record<RenderBand, boolean>>;
  readonly relativeOrderPreserved: Readonly<Record<RenderBand, boolean>>;
}

export interface OwnedMutationReplay {
  readonly history: OwnedMutationHistory;
  readonly bandsTrusted: boolean;
  readonly retainedMutation?: ElementMutation;
}

export const STABLE_RELATIVE_ORDER: Readonly<Record<RenderBand, boolean>> = Object.freeze({
  content: true,
  highlight: true,
});
const UNKNOWN_RELATIVE_ORDER: Readonly<Record<RenderBand, boolean>> = Object.freeze({
  content: false,
  highlight: false,
});

export function ownedReplayRecords(
  requested: ElementMutation,
  replay?: AppliedElementMutation,
  owned?: OwnedMutationHistory,
): ReadonlyMap<string, ElementRecord> | undefined {
  if (replay === undefined || owned === undefined) return undefined;
  return requested === replay.forward ? owned.forward : owned.reverse;
}

export function restoreOwnedRecord(
  element: InkElementV1,
  current: ElementRecord | undefined,
  owned: ElementRecord | undefined,
  versions: Readonly<{ geometryVersion: number; paintVersion: number }>,
): ElementRecord | undefined {
  const steps = restoreOwnedRecordSteps(element, current, owned, versions);
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}

export function* restoreOwnedRecordSteps(
  element: InkElementV1,
  current: ElementRecord | undefined,
  owned: ElementRecord | undefined,
  versions: Readonly<{ geometryVersion: number; paintVersion: number }>,
  samplesPerStep = 256,
): Generator<void, ElementRecord | undefined> {
  if (owned === undefined || !(yield* elementsEqualSteps(owned.element, element, samplesPerStep))) {
    return undefined;
  }
  if (current === undefined) {
    return assignRecordVersions(owned, versions.geometryVersion, versions.paintVersion);
  }
  if (yield* elementsEqualSteps(current.element, element, samplesPerStep)) return current;
  const domains = yield* classifyReplacementSteps(current.element, element, samplesPerStep);
  return assignRecordVersions(
    owned,
    domains.includes("geometry") ? versions.geometryVersion : current.geometryVersion,
    domains.includes("paint") ? versions.paintVersion : current.paintVersion,
  );
}

function historyBuilder(
  delta: StoreDelta,
  relativeOrderPreserved: Readonly<Record<RenderBand, boolean>>,
) {
  const forward = new Map<string, ElementRecord>();
  const reverse = new Map<string, ElementRecord>();
  const payload = createRetainedRecordPayload();
  const add = (records: Map<string, ElementRecord>, record: ElementRecord | null) => {
    if (record === null) return;
    records.set(record.element.id, record);
    payload.add(record);
  };
  return {
    append: ({ before, after }: StoreDelta["changes"][number]) => {
      if (before === after) return;
      add(forward, after);
      add(reverse, before);
    },
    finish: (): OwnedMutationHistory => ({
      forward,
      reverse,
      payloadBytes: payload.bytes,
      dirtyBands: delta.dirtyBands,
      relativeOrderPreserved: Object.freeze(relativeOrderPreserved),
    }),
  };
}

/** Count directional references and unique retained records, including shared sample buffers. */
export function createRetainedRecordPayload() {
  const retained = new Set<ElementRecord>();
  let bytes = 64;
  return {
    add(record: ElementRecord | null): void {
      if (record === null) return;
      bytes += 80;
      if (retained.has(record)) return;
      retained.add(record);
      bytes += 128 + elementMutationPayloadBytes(record.element);
    },
    get bytes(): number {
      return bytes;
    },
  };
}

export function captureOwnedMutationHistory(
  delta: StoreDelta,
  relativeOrderPreserved = UNKNOWN_RELATIVE_ORDER,
): OwnedMutationHistory {
  const builder = historyBuilder(delta, relativeOrderPreserved);
  for (const change of delta.changes) builder.append(change);
  return builder.finish();
}

export async function prepareOwnedMutationHistory(
  delta: StoreDelta,
  scheduler: MutationPreparationScheduler,
  retained?: OwnedMutationHistory,
  replaying = false,
  relativeOrderPreserved = UNKNOWN_RELATIVE_ORDER,
): Promise<OwnedMutationHistory | "cancelled" | undefined> {
  if (retained !== undefined || replaying) return retained;
  const builder = historyBuilder(delta, relativeOrderPreserved);
  for (const change of delta.changes) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    builder.append(change);
  }
  return builder.finish();
}

export function ownedHistoryPayloadBytes(history: OwnedMutationHistory | undefined): number {
  return history?.payloadBytes ?? 0;
}
