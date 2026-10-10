import { elementMutationPayloadBytes } from "./mutation-payload";
import { classifyReplacement, elementsEqual } from "./element-comparison";
import { assignRecordVersions } from "./record-factory";
import type { InkElementV1 } from "../schema/public";
import type { MutationPreparationScheduler } from "./mutation-preparation-scheduler";
import type { AppliedElementMutation, ElementMutation, ElementRecord, StoreDelta } from "./types";

export interface OwnedMutationHistory {
  readonly forward: ReadonlyMap<string, ElementRecord>;
  readonly reverse: ReadonlyMap<string, ElementRecord>;
  readonly payloadBytes: number;
}

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
  if (owned === undefined || !elementsEqual(owned.element, element)) return undefined;
  if (current === undefined) {
    return assignRecordVersions(owned, versions.geometryVersion, versions.paintVersion);
  }
  if (elementsEqual(current.element, element)) return current;
  const domains = classifyReplacement(current.element, element);
  return assignRecordVersions(
    owned,
    domains.includes("geometry") ? versions.geometryVersion : current.geometryVersion,
    domains.includes("paint") ? versions.paintVersion : current.paintVersion,
  );
}

function historyBuilder() {
  const forward = new Map<string, ElementRecord>();
  const reverse = new Map<string, ElementRecord>();
  const retained = new Set<ElementRecord>();
  let payloadBytes = 0;
  const add = (records: Map<string, ElementRecord>, record: ElementRecord | null) => {
    if (record === null) return;
    records.set(record.element.id, record);
    // Each directional map entry and each unique record, bounds and sample buffer
    // count toward the existing history cap, including buffers shared with the Store.
    payloadBytes += 80;
    if (retained.has(record)) return;
    retained.add(record);
    payloadBytes += 128 + elementMutationPayloadBytes(record.element);
  };
  return {
    append: ({ before, after }: StoreDelta["changes"][number]) => {
      if (before === after) return;
      add(forward, after);
      add(reverse, before);
    },
    finish: (): OwnedMutationHistory => ({ forward, reverse, payloadBytes }),
  };
}

export function captureOwnedMutationHistory(delta: StoreDelta): OwnedMutationHistory {
  const builder = historyBuilder();
  for (const change of delta.changes) builder.append(change);
  return builder.finish();
}

export async function prepareOwnedMutationHistory(
  delta: StoreDelta,
  scheduler: MutationPreparationScheduler,
  retained?: OwnedMutationHistory,
  replaying = false,
): Promise<OwnedMutationHistory | "cancelled" | undefined> {
  if (retained !== undefined || replaying) return retained;
  const builder = historyBuilder();
  for (const change of delta.changes) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    builder.append(change);
  }
  return builder.finish();
}

export function ownedHistoryPayloadBytes(history: OwnedMutationHistory | undefined): number {
  return history?.payloadBytes ?? 0;
}
