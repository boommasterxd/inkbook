export interface PersistentMapViewV1<K, V> {
  readonly size: number;
  get(key: K): V | undefined;
  has(key: K): boolean;
  entriesByCanonicalKey(): Iterable<readonly [K, V]>;
}

export interface PathCopyStatsV1 {
  readonly visitedNodes: number;
  readonly allocatedNodes: number;
}

export interface PersistentMapUpdateV1<K extends string, V> {
  readonly map: PersistentMapV1<K, V>;
  readonly stats: PathCopyStatsV1;
}

interface MapNode<K, V> {
  readonly key: K;
  readonly value: V;
  readonly left: MapNode<K, V> | null;
  readonly right: MapNode<K, V> | null;
  readonly height: number;
  readonly size: number;
}

interface MutableStats {
  visitedNodes: number;
  allocatedNodes: number;
}

const MAX_BMP_CODE_POINT = 0xffff;
const SURROGATE_CODE_UNIT_WIDTH = 2;
const NEGATIVE_BALANCE_LIMIT = -1;

function height<K, V>(node: MapNode<K, V> | null): number {
  return node?.height ?? 0;
}

function size<K, V>(node: MapNode<K, V> | null): number {
  return node?.size ?? 0;
}

function createNode<K, V>(
  key: K,
  value: V,
  left: MapNode<K, V> | null,
  right: MapNode<K, V> | null,
  stats?: MutableStats,
): MapNode<K, V> {
  if (stats !== undefined) {
    stats.allocatedNodes += 1;
  }
  return Object.freeze({
    key,
    value,
    left,
    right,
    height: Math.max(height(left), height(right)) + 1,
    size: size(left) + size(right) + 1,
  });
}

function compareCanonicalStrings(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = left.codePointAt(leftIndex);
    const rightPoint = right.codePointAt(rightIndex);
    if (leftPoint === undefined || rightPoint === undefined) {
      break;
    }
    if (leftPoint !== rightPoint) {
      return leftPoint - rightPoint;
    }
    leftIndex += leftPoint > MAX_BMP_CODE_POINT ? SURROGATE_CODE_UNIT_WIDTH : 1;
    rightIndex +=
      rightPoint > MAX_BMP_CODE_POINT ? SURROGATE_CODE_UNIT_WIDTH : 1;
  }
  return left.length - right.length;
}

function balance<K extends string, V>(
  key: K,
  value: V,
  left: MapNode<K, V> | null,
  right: MapNode<K, V> | null,
  stats: MutableStats,
): MapNode<K, V> {
  const difference = height(left) - height(right);
  if (difference > 1 && left !== null) {
    if (height(left.left) >= height(left.right)) {
      const moved = createNode(key, value, left.right, right, stats);
      return createNode(left.key, left.value, left.left, moved, stats);
    }
    const pivot = left.right;
    if (pivot !== null) {
      const newLeft = createNode(
        left.key,
        left.value,
        left.left,
        pivot.left,
        stats,
      );
      const newRight = createNode(key, value, pivot.right, right, stats);
      return createNode(pivot.key, pivot.value, newLeft, newRight, stats);
    }
  }
  if (difference < NEGATIVE_BALANCE_LIMIT && right !== null) {
    if (height(right.right) >= height(right.left)) {
      const moved = createNode(key, value, left, right.left, stats);
      return createNode(right.key, right.value, moved, right.right, stats);
    }
    const pivot = right.left;
    if (pivot !== null) {
      const newLeft = createNode(key, value, left, pivot.left, stats);
      const newRight = createNode(
        right.key,
        right.value,
        pivot.right,
        right.right,
        stats,
      );
      return createNode(pivot.key, pivot.value, newLeft, newRight, stats);
    }
  }
  return createNode(key, value, left, right, stats);
}

function setNode<K extends string, V>(
  node: MapNode<K, V> | null,
  key: K,
  value: V,
  stats: MutableStats,
): MapNode<K, V> {
  if (node === null) {
    return createNode(key, value, null, null, stats);
  }
  stats.visitedNodes += 1;
  const comparison = compareCanonicalStrings(key, node.key);
  if (comparison === 0) {
    return Object.is(value, node.value)
      ? node
      : createNode(key, value, node.left, node.right, stats);
  }
  if (comparison < 0) {
    const nextLeft = setNode(node.left, key, value, stats);
    return nextLeft === node.left
      ? node
      : balance(node.key, node.value, nextLeft, node.right, stats);
  }
  const nextRight = setNode(node.right, key, value, stats);
  return nextRight === node.right
    ? node
    : balance(node.key, node.value, node.left, nextRight, stats);
}

function smallest<K, V>(node: MapNode<K, V>): MapNode<K, V> {
  let current = node;
  while (current.left !== null) {
    current = current.left;
  }
  return current;
}

function deleteNode<K extends string, V>(
  node: MapNode<K, V> | null,
  key: K,
  stats: MutableStats,
): MapNode<K, V> | null {
  if (node === null) {
    return null;
  }
  stats.visitedNodes += 1;
  const comparison = compareCanonicalStrings(key, node.key);
  if (comparison < 0) {
    const left = deleteNode(node.left, key, stats);
    return left === node.left
      ? node
      : balance(node.key, node.value, left, node.right, stats);
  }
  if (comparison > 0) {
    const right = deleteNode(node.right, key, stats);
    return right === node.right
      ? node
      : balance(node.key, node.value, node.left, right, stats);
  }
  if (node.left === null) return node.right;
  if (node.right === null) return node.left;
  const successor = smallest(node.right);
  return balance(
    successor.key,
    successor.value,
    node.left,
    deleteNode(node.right, successor.key, stats),
    stats,
  );
}

function* entries<K, V>(
  root: MapNode<K, V> | null,
): Generator<readonly [K, V]> {
  const stack: MapNode<K, V>[] = [];
  let current = root;
  while (current !== null || stack.length > 0) {
    while (current !== null) {
      stack.push(current);
      current = current.left;
    }
    const next = stack.pop();
    if (next === undefined) return;
    yield Object.freeze([next.key, next.value] as const);
    current = next.right;
  }
}

export class PersistentMapV1<
  K extends string,
  V,
> implements PersistentMapViewV1<K, V> {
  readonly #root: MapNode<K, V> | null;
  public readonly size: number;

  private constructor(root: MapNode<K, V> | null) {
    this.#root = root;
    this.size = size(root);
    Object.freeze(this);
  }

  public static empty<K extends string, V>(): PersistentMapV1<K, V> {
    return new PersistentMapV1<K, V>(null);
  }

  public static fromEntries<K extends string, V>(
    source: Iterable<readonly [K, V]>,
  ): PersistentMapV1<K, V> {
    let map = PersistentMapV1.empty<K, V>();
    for (const [key, value] of source) {
      map = map.set(key, value);
    }
    return map;
  }

  public get(key: K): V | undefined {
    let current = this.#root;
    while (current !== null) {
      const comparison = compareCanonicalStrings(key, current.key);
      if (comparison === 0) return current.value;
      current = comparison < 0 ? current.left : current.right;
    }
    return undefined;
  }

  public has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  public entriesByCanonicalKey(): Iterable<readonly [K, V]> {
    return entries(this.#root);
  }

  public set(key: K, value: V): PersistentMapV1<K, V> {
    return this.setWithStats(key, value).map;
  }

  public setWithStats(key: K, value: V): PersistentMapUpdateV1<K, V> {
    const stats: MutableStats = { visitedNodes: 0, allocatedNodes: 0 };
    const root = setNode(this.#root, key, value, stats);
    return Object.freeze({
      map: root === this.#root ? this : new PersistentMapV1(root),
      stats: Object.freeze({ ...stats }),
    });
  }

  public delete(key: K): PersistentMapV1<K, V> {
    return this.deleteWithStats(key).map;
  }

  public deleteWithStats(key: K): PersistentMapUpdateV1<K, V> {
    const stats: MutableStats = { visitedNodes: 0, allocatedNodes: 0 };
    const root = deleteNode(this.#root, key, stats);
    return Object.freeze({
      map: root === this.#root ? this : new PersistentMapV1(root),
      stats: Object.freeze({ ...stats }),
    });
  }
}
