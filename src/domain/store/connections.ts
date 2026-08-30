import { isAnchorTarget, resolveShapeAnchor } from "../geometry/anchors";
import { linearPivot, pointDistance } from "../geometry/primitives";
import type { InkElementV1, LineElementV1, ArrowElementV1 } from "../schema/public";

import { mutableElement } from "./immutability";
import type { EndpointReference, ImmutableInkElement } from "./types";

export type ConnectableElement = LineElementV1 | ArrowElementV1;

export function isConnectable(
  element: ImmutableInkElement | InkElementV1,
): element is ConnectableElement {
  return element.kind === "line" || element.kind === "arrow";
}

export { isAnchorTarget } from "../geometry/anchors";

export function connectionReferences(
  element: ImmutableInkElement | InkElementV1,
): readonly { readonly reference: EndpointReference; readonly targetId: string }[] {
  if (!isConnectable(element)) return [];
  const references: { reference: EndpointReference; targetId: string }[] = [];
  if (element.startConnection !== null) {
    references.push({
      reference: { endpoint: "start", linearId: element.id },
      targetId: element.startConnection.targetId,
    });
  }
  if (element.endConnection !== null) {
    references.push({
      reference: { endpoint: "end", linearId: element.id },
      targetId: element.endConnection.targetId,
    });
  }
  return references;
}

export function addConnectionReferences(
  reverseConnections: Map<string, EndpointReference[]>,
  element: ImmutableInkElement,
): void {
  for (const { reference, targetId } of connectionReferences(element)) {
    const references = reverseConnections.get(targetId) ?? [];
    if (!reverseConnections.has(targetId)) reverseConnections.set(targetId, references);
    references.push(Object.freeze(reference));
  }
}

export function removeConnectionReferences(
  reverseConnections: Map<string, EndpointReference[]>,
  element: ImmutableInkElement,
): void {
  for (const { reference, targetId } of connectionReferences(element)) {
    const references = reverseConnections.get(targetId);
    if (references === undefined) continue;
    const index = references.findIndex(
      (candidate) =>
        candidate.linearId === reference.linearId && candidate.endpoint === reference.endpoint,
    );
    if (index >= 0) references.splice(index, 1);
    if (references.length === 0) reverseConnections.delete(targetId);
  }
}

export function prepareConnectionDetachments(
  removedIds: ReadonlySet<string>,
  reverseConnections: ReadonlyMap<string, readonly EndpointReference[]>,
  getElement: (id: string) => ImmutableInkElement,
  onVisit: () => void,
): Map<string, InkElementV1> {
  const detached = new Map<string, InkElementV1>();
  for (const targetId of removedIds) {
    const references = reverseConnections.get(targetId);
    if (references === undefined) continue;
    for (const reference of references) {
      onVisit();
      if (removedIds.has(reference.linearId)) continue;
      const source = detached.get(reference.linearId) ?? getElement(reference.linearId);
      const replacement = detachTargets(source, removedIds);
      if (replacement !== null) detached.set(reference.linearId, replacement);
    }
  }
  return detached;
}

export function resolveConnections(
  element: ImmutableInkElement | InkElementV1,
  lookup: (id: string) => ImmutableInkElement | InkElementV1 | undefined,
  invalidAnchor: "detach" | "reject" = "reject",
): InkElementV1 {
  const resolved = mutableElement(element);
  if (!isConnectable(resolved)) return resolved;
  resolveEndpoint(resolved, "start", lookup, invalidAnchor);
  resolveEndpoint(resolved, "end", lookup, invalidAnchor);
  if (pointDistance(resolved.start, resolved.end) < 8) {
    throw new RangeError("Connected linear elements must remain at least 8 page units long.");
  }
  resolved.pivot = linearPivot(resolved.start, resolved.end, resolved.bend);
  return resolved;
}

export function assertResolvedConnections(
  element: ImmutableInkElement | InkElementV1,
  lookup: (id: string) => ImmutableInkElement | InkElementV1 | undefined,
): void {
  if (!isConnectable(element)) return;
  assertEndpointResolved(element, "start", lookup);
  assertEndpointResolved(element, "end", lookup);
}

function detachTargets(
  element: ImmutableInkElement,
  removedIds: ReadonlySet<string>,
): InkElementV1 | null {
  if (!isConnectable(element)) return null;
  const detachStart =
    element.startConnection !== null && removedIds.has(element.startConnection.targetId);
  const detachEnd =
    element.endConnection !== null && removedIds.has(element.endConnection.targetId);
  if (!detachStart && !detachEnd) return null;
  const replacement = mutableElement(element);
  if (!isConnectable(replacement)) throw new Error("Expected a connectable replacement.");
  if (detachStart) replacement.startConnection = null;
  if (detachEnd) replacement.endConnection = null;
  return replacement;
}

function resolveEndpoint(
  element: ConnectableElement,
  endpoint: "start" | "end",
  lookup: (id: string) => ImmutableInkElement | InkElementV1 | undefined,
  invalidAnchor: "detach" | "reject",
): void {
  const connection = endpoint === "start" ? element.startConnection : element.endConnection;
  if (connection === null) return;
  const point = resolveConnectionAnchor(connection, lookup);
  if (point === null) {
    if (invalidAnchor === "detach") {
      setConnection(element, endpoint, null);
      return;
    }
    throw new RangeError("The connection anchor is invalid for its target.");
  }
  element[endpoint] = point;
}

function setConnection(element: ConnectableElement, endpoint: "start" | "end", value: null): void {
  if (endpoint === "start") element.startConnection = value;
  else element.endConnection = value;
}

function assertEndpointResolved(
  element: ConnectableElement,
  endpoint: "start" | "end",
  lookup: (id: string) => ImmutableInkElement | InkElementV1 | undefined,
): void {
  const connection = endpoint === "start" ? element.startConnection : element.endConnection;
  if (connection === null) return;
  const expected = resolveConnectionAnchor(connection, lookup);
  if (expected === null || pointDistance(element[endpoint], expected) > 0.001) {
    throw new RangeError("Connected endpoints must match their resolved semantic anchors.");
  }
}

function resolveConnectionAnchor(
  connection: ConnectableElement["startConnection"] & object,
  lookup: (id: string) => ImmutableInkElement | InkElementV1 | undefined,
): { x: number; y: number } | null {
  const target = lookup(connection.targetId);
  if (target === undefined || !isAnchorTarget(target)) {
    throw new RangeError("Connections must reference an existing eligible target.");
  }
  return resolveShapeAnchor(target, connection.anchor);
}
