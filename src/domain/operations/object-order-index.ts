import type { ElementId } from "../model/index";
import { PersistentMapV1, type PersistentSequenceViewV1 } from "../scene/index";
import { interpolateOrderKeysV1, type OrderKeyV1 } from "./object-order-key";
import type {
  ObjectOrderIndexResultV1,
  ObjectOrderIndexStatsV1,
  OrderPlacementV1,
} from "./types";

const BEFORE = -1;
const ZERO_BIGINT = 0n;
const ONE_BIGINT = 1n;
const BINARY_RADIX = 2;
const HALF = 2;

interface OrderNodeV1 {
  readonly key: OrderKeyV1;
  readonly elementId: ElementId;
  readonly left: OrderNodeV1 | null;
  readonly right: OrderNodeV1 | null;
  readonly height: number;
  readonly size: number;
}

interface MutableOrderStatsV1 {
  visitedNodes: number;
  allocatedNodes: number;
}

function orderFailure(
  code: "invalid-placement" | "resource-limit" = "invalid-placement",
): ObjectOrderIndexResultV1 {
  return Object.freeze({ ok: false, code });
}

function nodeHeight(node: OrderNodeV1 | null): number {
  return node?.height ?? 0;
}

function nodeSize(node: OrderNodeV1 | null): number {
  return node?.size ?? 0;
}

function compareKeys(left: OrderKeyV1, right: OrderKeyV1): number {
  const difference =
    left.numerator * right.denominator - right.numerator * left.denominator;
  if (difference < ZERO_BIGINT) return BEFORE;
  if (difference > ZERO_BIGINT) return 1;
  return 0;
}

function createNode(
  key: OrderKeyV1,
  elementId: ElementId,
  left: OrderNodeV1 | null,
  right: OrderNodeV1 | null,
  stats: MutableOrderStatsV1,
): OrderNodeV1 {
  stats.allocatedNodes += 1;
  return Object.freeze({
    key,
    elementId,
    left,
    right,
    height: Math.max(nodeHeight(left), nodeHeight(right)) + 1,
    size: nodeSize(left) + nodeSize(right) + 1,
  });
}

function balance(
  key: OrderKeyV1,
  elementId: ElementId,
  left: OrderNodeV1 | null,
  right: OrderNodeV1 | null,
  stats: MutableOrderStatsV1,
): OrderNodeV1 {
  const difference = nodeHeight(left) - nodeHeight(right);
  if (difference > 1 && left !== null) {
    if (nodeHeight(left.left) >= nodeHeight(left.right)) {
      const moved = createNode(key, elementId, left.right, right, stats);
      return createNode(left.key, left.elementId, left.left, moved, stats);
    }
    const pivot = left.right;
    if (pivot !== null) {
      const newLeft = createNode(
        left.key,
        left.elementId,
        left.left,
        pivot.left,
        stats,
      );
      const newRight = createNode(key, elementId, pivot.right, right, stats);
      return createNode(pivot.key, pivot.elementId, newLeft, newRight, stats);
    }
  }
  if (difference < BEFORE && right !== null) {
    if (nodeHeight(right.right) >= nodeHeight(right.left)) {
      const moved = createNode(key, elementId, left, right.left, stats);
      return createNode(right.key, right.elementId, moved, right.right, stats);
    }
    const pivot = right.left;
    if (pivot !== null) {
      const newLeft = createNode(key, elementId, left, pivot.left, stats);
      const newRight = createNode(
        right.key,
        right.elementId,
        pivot.right,
        right.right,
        stats,
      );
      return createNode(pivot.key, pivot.elementId, newLeft, newRight, stats);
    }
  }
  return createNode(key, elementId, left, right, stats);
}

function insertNode(
  node: OrderNodeV1 | null,
  key: OrderKeyV1,
  elementId: ElementId,
  stats: MutableOrderStatsV1,
): OrderNodeV1 | null {
  if (node === null) return createNode(key, elementId, null, null, stats);
  stats.visitedNodes += 1;
  const comparison = compareKeys(key, node.key);
  if (comparison === 0) return null;
  if (comparison < 0) {
    const next = insertNode(node.left, key, elementId, stats);
    return next === null
      ? null
      : balance(node.key, node.elementId, next, node.right, stats);
  }
  const next = insertNode(node.right, key, elementId, stats);
  return next === null
    ? null
    : balance(node.key, node.elementId, node.left, next, stats);
}

function smallest(node: OrderNodeV1): OrderNodeV1 {
  let current = node;
  while (current.left !== null) current = current.left;
  return current;
}

function deleteNode(
  node: OrderNodeV1 | null,
  key: OrderKeyV1,
  stats: MutableOrderStatsV1,
): OrderNodeV1 | null {
  if (node === null) return null;
  stats.visitedNodes += 1;
  const comparison = compareKeys(key, node.key);
  if (comparison < 0) {
    const left = deleteNode(node.left, key, stats);
    return left === node.left
      ? node
      : balance(node.key, node.elementId, left, node.right, stats);
  }
  if (comparison > 0) {
    const right = deleteNode(node.right, key, stats);
    return right === node.right
      ? node
      : balance(node.key, node.elementId, node.left, right, stats);
  }
  if (node.left === null) return node.right;
  if (node.right === null) return node.left;
  const successor = smallest(node.right);
  return balance(
    successor.key,
    successor.elementId,
    node.left,
    deleteNode(node.right, successor.key, stats),
    stats,
  );
}

function rankOf(root: OrderNodeV1 | null, key: OrderKeyV1): number {
  let node = root;
  let rank = 0;
  while (node !== null) {
    const comparison = compareKeys(key, node.key);
    if (comparison === 0) return rank + nodeSize(node.left);
    if (comparison < 0) node = node.left;
    else {
      rank += nodeSize(node.left) + 1;
      node = node.right;
    }
  }
  return BEFORE;
}

function keyAt(root: OrderNodeV1 | null, index: number): OrderKeyV1 | null {
  let node = root;
  let remaining = index;
  while (node !== null) {
    const leftSize = nodeSize(node.left);
    if (remaining === leftSize) return node.key;
    if (remaining < leftSize) node = node.left;
    else {
      remaining -= leftSize + 1;
      node = node.right;
    }
  }
  return null;
}

function uniqueIds(ids: readonly ElementId[]): boolean {
  return ids.length > 0 && new Set(ids).size === ids.length;
}

function buildInitialTree(
  elementIds: readonly ElementId[],
  start: number,
  end: number,
  stats: MutableOrderStatsV1,
): OrderNodeV1 | null {
  if (start >= end) return null;
  const middle = start + Math.floor((end - start) / HALF);
  const left = buildInitialTree(elementIds, start, middle, stats);
  const right = buildInitialTree(elementIds, middle + 1, end, stats);
  const elementId = elementIds[middle];
  if (elementId === undefined) return null;
  return createNode(
    Object.freeze({ numerator: BigInt(middle), denominator: ONE_BIGINT }),
    elementId,
    left,
    right,
    stats,
  );
}

export class ObjectOrderIndexV1 {
  readonly #root: OrderNodeV1 | null;
  readonly #keysById: PersistentMapV1<ElementId, OrderKeyV1>;

  private constructor(
    root: OrderNodeV1 | null,
    keysById: PersistentMapV1<ElementId, OrderKeyV1>,
  ) {
    this.#root = root;
    this.#keysById = keysById;
    Object.freeze(this);
  }

  public static fromSequence(
    sequence: PersistentSequenceViewV1<ElementId>,
  ): ObjectOrderIndexV1 | null {
    const elementIds: ElementId[] = [];
    let keysById = PersistentMapV1.empty<ElementId, OrderKeyV1>();
    for (let position = 0; position < sequence.length; position += 1) {
      const elementId = sequence.get(position);
      if (elementId === undefined || keysById.has(elementId)) return null;
      const key = Object.freeze({
        numerator: BigInt(position),
        denominator: ONE_BIGINT,
      });
      elementIds.push(elementId);
      keysById = keysById.set(elementId, key);
    }
    const stats: MutableOrderStatsV1 = { visitedNodes: 0, allocatedNodes: 0 };
    return new ObjectOrderIndexV1(
      buildInitialTree(elementIds, 0, elementIds.length, stats),
      keysById,
    );
  }

  public positionOf(elementId: ElementId): number {
    const key = this.#keysById.get(elementId);
    return key === undefined ? BEFORE : rankOf(this.#root, key);
  }

  public validateBlock(placement: OrderPlacementV1): number | null {
    if (!uniqueIds(placement.movedElementIds)) return null;
    const firstElementId = placement.movedElementIds[0];
    if (firstElementId === undefined) return null;
    const first = this.positionOf(firstElementId);
    if (first < 0) return null;
    for (
      let offset = 0;
      offset < placement.movedElementIds.length;
      offset += 1
    ) {
      const elementId = placement.movedElementIds[offset];
      if (
        elementId === undefined ||
        this.positionOf(elementId) !== first + offset
      ) {
        return null;
      }
    }
    const predecessorPosition = first - 1;
    const successorPosition = first + placement.movedElementIds.length;
    if (!this.anchorMatches(placement.predecessorId, predecessorPosition)) {
      return null;
    }
    return this.anchorMatches(placement.successorId, successorPosition)
      ? first
      : null;
  }

  public insert(placement: OrderPlacementV1): ObjectOrderIndexResultV1 {
    if (!uniqueIds(placement.movedElementIds)) return orderFailure();
    if (placement.movedElementIds.some((id) => this.#keysById.has(id))) {
      return orderFailure();
    }
    const insertion = this.insertionIndex(placement);
    if (insertion === null) return orderFailure();
    return this.insertAt(insertion, placement.movedElementIds);
  }

  public delete(placement: OrderPlacementV1): ObjectOrderIndexResultV1 {
    const start = this.validateBlock(placement);
    if (start === null) return orderFailure();
    const removed = this.removeIds(placement.movedElementIds);
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        ...removed,
        start,
        destinationAfterRemoval: start,
      }),
    });
  }

  public move(
    prior: OrderPlacementV1,
    replacement: OrderPlacementV1,
  ): ObjectOrderIndexResultV1 {
    if (
      prior.movedElementIds.length !== replacement.movedElementIds.length ||
      prior.movedElementIds.some(
        (id, index) => replacement.movedElementIds[index] !== id,
      )
    ) {
      return orderFailure();
    }
    const start = this.validateBlock(prior);
    if (start === null) return orderFailure();
    const removed = this.removeIds(prior.movedElementIds);
    const insertion = removed.index.insertionIndex(replacement);
    if (insertion === null) return orderFailure();
    const inserted = removed.index.insertAt(
      insertion,
      replacement.movedElementIds,
    );
    if (!inserted.ok) return orderFailure(inserted.code);
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        index: inserted.value.index,
        start,
        destinationAfterRemoval: insertion,
        stats: Object.freeze({
          visitedNodes:
            removed.stats.visitedNodes + inserted.value.stats.visitedNodes,
          allocatedNodes:
            removed.stats.allocatedNodes + inserted.value.stats.allocatedNodes,
          maximumKeyBits: Math.max(
            removed.stats.maximumKeyBits,
            inserted.value.stats.maximumKeyBits,
          ),
        }),
      }),
    });
  }

  private anchorMatches(
    elementId: ElementId | null,
    position: number,
  ): boolean {
    if (position < 0 || position >= nodeSize(this.#root))
      return elementId === null;
    return elementId !== null && this.positionOf(elementId) === position;
  }

  private insertionIndex(placement: OrderPlacementV1): number | null {
    const length = nodeSize(this.#root);
    if (length === 0) {
      return placement.predecessorId === null && placement.successorId === null
        ? 0
        : null;
    }
    if (placement.predecessorId === null) {
      return this.anchorMatches(placement.successorId, 0) ? 0 : null;
    }
    const predecessor = this.positionOf(placement.predecessorId);
    if (predecessor < 0) return null;
    const insertion = predecessor + 1;
    return this.anchorMatches(placement.successorId, insertion)
      ? insertion
      : null;
  }

  private insertAt(
    position: number,
    elementIds: readonly ElementId[],
  ): ObjectOrderIndexResultV1 {
    const stats: MutableOrderStatsV1 = { visitedNodes: 0, allocatedNodes: 0 };
    const keys = interpolateOrderKeysV1(
      keyAt(this.#root, position - 1),
      keyAt(this.#root, position),
      elementIds.length,
    );
    if (keys === null) {
      return orderFailure("resource-limit");
    }
    let root = this.#root;
    let keysById = this.#keysById;
    for (let offset = 0; offset < elementIds.length; offset += 1) {
      const elementId = elementIds[offset];
      const key = keys[offset];
      if (
        elementId === undefined ||
        key === undefined ||
        keysById.has(elementId)
      ) {
        return orderFailure();
      }
      root = insertNode(root, key, elementId, stats);
      if (root === null) {
        return orderFailure();
      }
      const update = keysById.setWithStats(elementId, key);
      keysById = update.map;
      stats.visitedNodes += update.stats.visitedNodes;
      stats.allocatedNodes += update.stats.allocatedNodes;
    }
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        index: new ObjectOrderIndexV1(root, keysById),
        start: position,
        destinationAfterRemoval: position,
        stats: Object.freeze({
          ...stats,
          maximumKeyBits: keys.reduce(
            (maximum, key) =>
              Math.max(
                maximum,
                key.numerator.toString(BINARY_RADIX).length,
                key.denominator.toString(BINARY_RADIX).length,
              ),
            0,
          ),
        }),
      }),
    });
  }

  private removeIds(elementIds: readonly ElementId[]): {
    readonly index: ObjectOrderIndexV1;
    readonly stats: ObjectOrderIndexStatsV1;
  } {
    const stats: MutableOrderStatsV1 = { visitedNodes: 0, allocatedNodes: 0 };
    let root = this.#root;
    let keysById = this.#keysById;
    for (const elementId of elementIds) {
      const key = keysById.get(elementId);
      if (key === undefined) continue;
      root = deleteNode(root, key, stats);
      const update = keysById.deleteWithStats(elementId);
      keysById = update.map;
      stats.visitedNodes += update.stats.visitedNodes;
      stats.allocatedNodes += update.stats.allocatedNodes;
    }
    return Object.freeze({
      index: new ObjectOrderIndexV1(root, keysById),
      stats: Object.freeze({ ...stats, maximumKeyBits: 0 }),
    });
  }
}
