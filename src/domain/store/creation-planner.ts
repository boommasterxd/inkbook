import type { InkElementV1 } from "../schema/public";

import { isConnectable, resolveConnections } from "./connections";
import { createInitialRecord } from "./record-factory";
import { assertValidElement } from "./replacement-planner";
import type { ElementRecord, ImmutableInkElement } from "./types";

interface CreationPlannerPorts {
  readonly getExisting: (id: string) => ImmutableInkElement | undefined;
  readonly hasExisting: (id: string) => boolean;
}

export function prepareCreatedRecords(
  elements: readonly InkElementV1[],
  ports: CreationPlannerPorts,
): ElementRecord[] {
  const staged = new Map<string, InkElementV1>();
  for (const element of elements) {
    assertValidElement(element);
    if (ports.hasExisting(element.id) || staged.has(element.id)) {
      throw new RangeError(`Element ID already exists: ${element.id}`);
    }
    staged.set(element.id, element);
  }
  const initialLookup = (id: string) => staged.get(id) ?? ports.getExisting(id);
  const resolved = elements.map((element) =>
    isConnectable(element) ? resolveConnections(element, initialLookup) : element,
  );
  return resolved.map((element) => createInitialRecord(element));
}
