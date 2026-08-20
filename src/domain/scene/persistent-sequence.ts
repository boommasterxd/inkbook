import type { PathCopyStatsV1 } from "./persistent-map";

export interface PersistentSequenceViewV1<T> {
  readonly length: number;
  get(index: number): T | undefined;
}

export interface PersistentSequenceUpdateV1<T> {
  readonly sequence: PersistentSequenceV1<T>;
  readonly stats: PathCopyStatsV1;
}

interface LeafNode<T> {
  readonly kind: "leaf";
  readonly value: T;
  readonly length: 1;
  readonly height: 1;
}

interface BranchNode<T> {
  readonly kind: "branch";
  readonly left: SequenceNode<T>;
  readonly right: SequenceNode<T>;
  readonly length: number;
  readonly height: number;
}

type SequenceNode<T> = LeafNode<T> | BranchNode<T>;

interface MutableStats {
  visitedNodes: number;
  allocatedNodes: number;
}

const NEGATIVE_BALANCE_LIMIT = -1;
const BINARY_DIVISOR = 2;

function leaf<T>(value: T, stats?: MutableStats): LeafNode<T> {
  if (stats !== undefined) stats.allocatedNodes += 1;
  return Object.freeze({ kind: "leaf", value, length: 1, height: 1 });
}

function branch<T>(
  left: SequenceNode<T>,
  right: SequenceNode<T>,
  stats?: MutableStats,
): BranchNode<T> {
  if (stats !== undefined) stats.allocatedNodes += 1;
  return Object.freeze({
    kind: "branch",
    left,
    right,
    length: left.length + right.length,
    height: Math.max(left.height, right.height) + 1,
  });
}

function balance<T>(
  left: SequenceNode<T>,
  right: SequenceNode<T>,
  stats: MutableStats,
): SequenceNode<T> {
  const difference = left.height - right.height;
  if (difference > 1 && left.kind === "branch") {
    if (left.left.height >= left.right.height) {
      return branch(left.left, branch(left.right, right, stats), stats);
    }
    if (left.right.kind === "branch") {
      return branch(
        branch(left.left, left.right.left, stats),
        branch(left.right.right, right, stats),
        stats,
      );
    }
  }
  if (difference < NEGATIVE_BALANCE_LIMIT && right.kind === "branch") {
    if (right.right.height >= right.left.height) {
      return branch(branch(left, right.left, stats), right.right, stats);
    }
    if (right.left.kind === "branch") {
      return branch(
        branch(left, right.left.left, stats),
        branch(right.left.right, right.right, stats),
        stats,
      );
    }
  }
  return branch(left, right, stats);
}

function concat<T>(
  left: SequenceNode<T> | null,
  right: SequenceNode<T> | null,
  stats: MutableStats,
): SequenceNode<T> | null {
  if (left === null) return right;
  if (right === null) return left;
  stats.visitedNodes += 1;
  if (left.height > right.height + 1 && left.kind === "branch") {
    const joined = concat(left.right, right, stats);
    return joined === null ? left.left : balance(left.left, joined, stats);
  }
  if (right.height > left.height + 1 && right.kind === "branch") {
    const joined = concat(left, right.left, stats);
    return joined === null ? right.right : balance(joined, right.right, stats);
  }
  return branch(left, right, stats);
}

function split<T>(
  node: SequenceNode<T> | null,
  index: number,
  stats: MutableStats,
): readonly [SequenceNode<T> | null, SequenceNode<T> | null] {
  if (node === null || index <= 0) return [null, node];
  if (index >= node.length) return [node, null];
  stats.visitedNodes += 1;
  if (node.kind === "leaf") return [node, null];
  if (index < node.left.length) {
    const [prefix, suffix] = split(node.left, index, stats);
    return [prefix, concat(suffix, node.right, stats)];
  }
  if (index === node.left.length) return [node.left, node.right];
  const [prefix, suffix] = split(node.right, index - node.left.length, stats);
  return [concat(node.left, prefix, stats), suffix];
}

function setNode<T>(
  node: SequenceNode<T>,
  index: number,
  value: T,
  stats: MutableStats,
): SequenceNode<T> {
  stats.visitedNodes += 1;
  if (node.kind === "leaf") {
    return Object.is(node.value, value) ? node : leaf(value, stats);
  }
  if (index < node.left.length) {
    const left = setNode(node.left, index, value, stats);
    return left === node.left ? node : branch(left, node.right, stats);
  }
  const right = setNode(node.right, index - node.left.length, value, stats);
  return right === node.right ? node : branch(node.left, right, stats);
}

function buildBalanced<T>(
  values: readonly T[],
  start: number,
  end: number,
): SequenceNode<T> | null {
  if (start >= end) return null;
  if (end - start === 1) return leaf(values[start] as T);
  const middle = start + Math.floor((end - start) / BINARY_DIVISOR);
  const left = buildBalanced(values, start, middle);
  const right = buildBalanced(values, middle, end);
  return left === null || right === null
    ? (left ?? right)
    : branch(left, right);
}

function buildInserted<T>(
  source: Iterable<T>,
  stats: MutableStats,
): SequenceNode<T> | null {
  let root: SequenceNode<T> | null = null;
  for (const value of source) {
    root = concat(root, leaf(value, stats), stats);
  }
  return root;
}

function* iterate<T>(root: SequenceNode<T> | null): Generator<T> {
  if (root === null) return;
  const stack: SequenceNode<T>[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) return;
    if (node.kind === "leaf") {
      yield node.value;
    } else {
      stack.push(node.right, node.left);
    }
  }
}

function checkSpliceBounds(length: number, index: number, count: number): void {
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(count) ||
    index < 0 ||
    count < 0 ||
    index + count > length
  ) {
    throw new RangeError("Persistent sequence splice is outside its bounds.");
  }
}

export class PersistentSequenceV1<T> implements PersistentSequenceViewV1<T> {
  readonly #root: SequenceNode<T> | null;
  public readonly length: number;

  private constructor(root: SequenceNode<T> | null) {
    this.#root = root;
    this.length = root?.length ?? 0;
    Object.freeze(this);
  }

  public static empty<T>(): PersistentSequenceV1<T> {
    return new PersistentSequenceV1<T>(null);
  }

  public static fromIterable<T>(source: Iterable<T>): PersistentSequenceV1<T> {
    const values = [...source];
    return new PersistentSequenceV1(buildBalanced(values, 0, values.length));
  }

  public get(index: number): T | undefined {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      return undefined;
    }
    let current = this.#root;
    let remaining = index;
    while (current !== null && current.kind === "branch") {
      if (remaining < current.left.length) current = current.left;
      else {
        remaining -= current.left.length;
        current = current.right;
      }
    }
    return current?.value;
  }

  public values(): Iterable<T> {
    return iterate(this.#root);
  }

  public set(index: number, value: T): PersistentSequenceV1<T> {
    return this.setWithStats(index, value).sequence;
  }

  public setWithStats(index: number, value: T): PersistentSequenceUpdateV1<T> {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError("Persistent sequence index is outside its bounds.");
    }
    if (this.#root === null) {
      throw new RangeError("An empty persistent sequence has no indices.");
    }
    const stats: MutableStats = { visitedNodes: 0, allocatedNodes: 0 };
    const root = setNode(this.#root, index, value, stats);
    return this.result(root, stats);
  }

  public spliceWithStats(
    index: number,
    deleteCount: number,
    items: Iterable<T>,
  ): PersistentSequenceUpdateV1<T> {
    checkSpliceBounds(this.length, index, deleteCount);
    const stats: MutableStats = { visitedNodes: 0, allocatedNodes: 0 };
    const [prefix, tail] = split(this.#root, index, stats);
    const [, suffix] = split(tail, deleteCount, stats);
    const inserted = buildInserted(items, stats);
    const root = concat(concat(prefix, inserted, stats), suffix, stats);
    return this.result(root, stats);
  }

  public moveWithStats(
    start: number,
    count: number,
    destinationAfterRemoval: number,
  ): PersistentSequenceUpdateV1<T> {
    checkSpliceBounds(this.length, start, count);
    checkSpliceBounds(this.length - count, destinationAfterRemoval, 0);
    const stats: MutableStats = { visitedNodes: 0, allocatedNodes: 0 };
    const [before, tail] = split(this.#root, start, stats);
    const [moved, after] = split(tail, count, stats);
    const remaining = concat(before, after, stats);
    const [prefix, suffix] = split(remaining, destinationAfterRemoval, stats);
    const root = concat(concat(prefix, moved, stats), suffix, stats);
    return this.result(root, stats);
  }

  private result(
    root: SequenceNode<T> | null,
    stats: MutableStats,
  ): PersistentSequenceUpdateV1<T> {
    return Object.freeze({
      sequence: root === this.#root ? this : new PersistentSequenceV1(root),
      stats: Object.freeze({ ...stats }),
    });
  }
}
