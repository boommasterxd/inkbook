import type { InkElementV1 } from "../schema/public";
import {
  assertResolvedConnections,
  isConnectable,
  prepareConnectionDetachments,
  resolveConnections,
} from "./connections";
import type { MutationPreparationScheduler } from "./mutation-preparation-scheduler";
import { requireElementRecord } from "./record-access";
import { assertReplacementIdentity } from "./replacement-planner";
import { prepareRuntimeElement } from "./runtime-element-preparation";
import type { ElementRecord, EndpointReference } from "./types";

interface MutationElementSource {
  readonly records: ReadonlyMap<string, ElementRecord>;
  readonly reverseConnections: ReadonlyMap<string, readonly EndpointReference[]>;
}

export async function collectDesiredElements(
  source: MutationElementSource,
  elements: readonly InkElementV1[],
  removeIds: ReadonlySet<string>,
  scheduler: MutationPreparationScheduler,
  ownedRecords?: ReadonlyMap<string, ElementRecord>,
): Promise<{ desired: Map<string, InkElementV1>; explicit: InkElementV1[] } | "cancelled"> {
  const desired = await collectConnectionDetachments(source, removeIds, scheduler);
  if (desired === "cancelled") return desired;
  const explicit: InkElementV1[] = [];
  for (const input of elements) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    const current = source.records.get(input.id);
    const owned = ownedRecords?.get(input.id);
    const pendingElement =
      owned?.element === input ? input : prepareRuntimeElement(input, current, owned, scheduler);
    const element = pendingElement instanceof Promise ? await pendingElement : pendingElement;
    if (element === "cancelled") return element;
    if (desired.has(element.id) && !removeIds.has(element.id) && owned?.element !== element) {
      throw new RangeError(`Duplicate mutation element ID: ${element.id}`);
    }
    if (removeIds.has(element.id))
      throw new RangeError(`Mutation cannot remove and set: ${element.id}`);
    if (current !== undefined) assertReplacementIdentity(current.element, element);
    desired.set(element.id, element);
    explicit.push(element);
  }
  if (
    (await resolveDesiredConnections(source, desired, removeIds, scheduler, ownedRecords)) ===
    "cancelled"
  )
    return "cancelled";
  return { desired, explicit };
}

async function resolveDesiredConnections(
  source: MutationElementSource,
  desired: Map<string, InkElementV1>,
  removeIds: ReadonlySet<string>,
  scheduler: MutationPreparationScheduler,
  ownedRecords?: ReadonlyMap<string, ElementRecord>,
): Promise<void | "cancelled"> {
  const lookup = (id: string) =>
    removeIds.has(id) ? undefined : (desired.get(id) ?? source.records.get(id)?.element);
  for (const [id, element] of desired) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    if (isConnectable(element)) {
      if (ownedRecords?.get(id)?.element === element) assertResolvedConnections(element, lookup);
      else desired.set(id, resolveConnections(element, lookup));
    }
  }
}

export async function buildIdSet(
  ids: readonly string[],
  scheduler: MutationPreparationScheduler,
): Promise<Set<string> | "cancelled"> {
  const result = new Set<string>();
  for (const id of ids) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    result.add(id);
  }
  return result;
}

async function collectConnectionDetachments(
  source: MutationElementSource,
  removeIds: ReadonlySet<string>,
  scheduler: MutationPreparationScheduler,
): Promise<Map<string, InkElementV1> | "cancelled"> {
  const detached = new Map<string, InkElementV1>();
  for (const targetId of removeIds) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    const additions = prepareConnectionDetachments(
      new Set([targetId]),
      source.reverseConnections,
      (id) => detached.get(id) ?? requireElementRecord(source.records, id).element,
      () => undefined,
    );
    for (const [id, element] of additions) {
      if (!removeIds.has(id)) detached.set(id, element);
    }
  }
  return detached;
}
