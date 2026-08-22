import { assertElementsWithinPageBounds, correctElementsToPageBounds } from "../geometry/public";
import type { InkElementV1 } from "../schema/public";

import { resolveConnections } from "./connections";
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
  const resolved = elements.map((element) => resolveConnections(element, initialLookup));
  const correction = correctElementsToPageBounds(resolved);
  if (correction.status === "rejected") {
    throw new RangeError("Created element geometry exceeds the supported page width.");
  }
  const correctedById = new Map(correction.elements.map((element) => [element.id, element]));
  const correctedLookup = (id: string) => correctedById.get(id) ?? ports.getExisting(id);
  const corrected = correction.elements.map((element) =>
    resolveConnections(element, correctedLookup),
  );
  assertElementsWithinPageBounds(corrected);
  return corrected.map((element) => createInitialRecord(element));
}
