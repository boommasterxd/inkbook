import { createSpatialNode, copySpatialNode, type SpatialNode } from "./spatial-node";

interface SpatialValue<Value> {
  readonly value: Value;
  readonly ordinal: bigint;
  readonly owner: object;
}

/** Shared identity ordering retains object keys weakly; primitive keys compare directly. */
class SpatialKeyOrder<Key> {
  private objects: WeakMap<object, bigint> | undefined;
  private nextIdentity = 0n;

  public compare(first: Key, second: Key): number {
    if (first === second || (Number.isNaN(first) && Number.isNaN(second))) return 0;
    const firstType = typeof first;
    const secondType = typeof second;
    if (firstType !== secondType) return firstType < secondType ? -1 : 1;
    if (first === null || second === null) return first === null ? -1 : 1;
    if (firstType === "object" || firstType === "function") {
      return this.identity(first) < this.identity(second) ? -1 : 1;
    }
    if (Number.isNaN(first) || Number.isNaN(second)) return Number.isNaN(first) ? -1 : 1;
    return first! < second! ? -1 : 1;
  }

  private identity(key: Key): bigint {
    const object = key as object;
    const objects = (this.objects ??= new WeakMap());
    let identity = objects.get(object);
    if (identity === undefined) objects.set(object, (identity = ++this.nextIdentity));
    return identity;
  }
}

/** Index-owned AVL roots permit local preparation without copying retained entries. */
export class SpatialMap<Key, Value> {
  private root: SpatialNode<Key, SpatialValue<Value>> | undefined;
  private ordered: SpatialNode<bigint, [Key, Value]> | undefined;
  private readonly order: SpatialKeyOrder<Key>;
  private readonly ordinals = new SpatialKeyOrder<bigint>();
  private nextOrdinal = 0n;
  private owner: object = {};
  public size = 0;

  public constructor(order = new SpatialKeyOrder<Key>()) {
    this.order = order;
  }

  public fork(): SpatialMap<Key, Value> {
    // Neither map may edit nodes or nested values carrying their former shared token.
    this.owner = {};
    const fork = new SpatialMap<Key, Value>(this.order);
    fork.root = this.root;
    fork.ordered = this.ordered;
    fork.nextOrdinal = this.nextOrdinal;
    fork.size = this.size;
    return fork;
  }

  public get(key: Key): Value | undefined {
    return this.find(key)?.value;
  }

  public getForUpdate(key: Key, forkValue: (value: Value) => Value): Value | undefined {
    const current = this.find(key);
    if (current === undefined) return undefined;
    if (current.owner === this.owner) return current.value;
    const value = forkValue(current.value);
    this.set(key, value);
    return value;
  }

  private find(key: Key): SpatialValue<Value> | undefined {
    if (typeof key === "symbol") throw new TypeError("Spatial symbol keys are unsupported.");
    let node = this.root;
    while (node !== undefined) {
      const comparison = this.order.compare(key, node.key);
      if (comparison === 0) return node.value;
      node = comparison < 0 ? node.left : node.right;
    }
    return undefined;
  }

  public set(key: Key, value: Value): this {
    const storedKey = key === 0 ? (0 as Key) : key;
    const ordinal = this.find(key)?.ordinal ?? this.nextOrdinal++;
    const change = { added: false };
    this.root = setSpatialNode(
      this.root,
      storedKey,
      { value, ordinal, owner: this.owner },
      this.order,
      change,
      this.owner,
    );
    this.ordered = setSpatialNode(
      this.ordered,
      ordinal,
      [storedKey, value],
      this.ordinals,
      {
        added: false,
      },
      this.owner,
    );
    this.size += Number(change.added);
    return this;
  }

  public delete(key: Key): boolean {
    const current = this.find(key);
    if (current === undefined) return false;
    const change = { removed: false };
    this.root = deleteSpatialNode(this.root, key, this.order, change, this.owner);
    this.ordered = deleteSpatialNode(
      this.ordered,
      current.ordinal,
      this.ordinals,
      {
        removed: false,
      },
      this.owner,
    );
    this.size -= Number(change.removed);
    return change.removed;
  }

  public entries(): MapIterator<[Key, Value]> {
    return this.iterate(copySpatialEntry);
  }

  public values(): MapIterator<Value> {
    return this.iterate(spatialEntryValue);
  }

  public keys(): MapIterator<Key> {
    return this.iterate(spatialEntryKey);
  }

  public [Symbol.iterator](): MapIterator<[Key, Value]> {
    return this.entries();
  }

  private *iterate<Result>(read: (entry: readonly [Key, Value]) => Result): MapIterator<Result> {
    const ancestors: SpatialNode<bigint, [Key, Value]>[] = [];
    let current = this.ordered;
    while (current !== undefined || ancestors.length !== 0) {
      while (current !== undefined) {
        ancestors.push(current);
        current = current.left;
      }
      const next = ancestors.pop()!;
      yield read(next.value);
      current = next.right;
    }
  }
}

function copySpatialEntry<Key, Value>(entry: readonly [Key, Value]): [Key, Value] {
  return [entry[0], entry[1]];
}

function spatialEntryKey<Key, Value>(entry: readonly [Key, Value]): Key {
  return entry[0];
}

function spatialEntryValue<Key, Value>(entry: readonly [Key, Value]): Value {
  return entry[1];
}

function height<Key, Value>(node: SpatialNode<Key, Value> | undefined): number {
  return node?.height ?? 0;
}

function ownSpatialNode<Key, Value>(
  node: SpatialNode<Key, Value>,
  owner: object,
): SpatialNode<Key, Value> {
  return node.owner === owner ? node : copySpatialNode(node, owner);
}

function updateHeight<Key, Value>(node: SpatialNode<Key, Value>): SpatialNode<Key, Value> {
  node.height = Math.max(height(node.left), height(node.right)) + 1;
  return node;
}

function rotateLeft<Key, Value>(
  node: SpatialNode<Key, Value>,
  owner: object,
): SpatialNode<Key, Value> {
  const right = ownSpatialNode(node.right!, owner);
  node.right = right.left;
  right.left = updateHeight(node);
  return updateHeight(right);
}

function rotateRight<Key, Value>(
  node: SpatialNode<Key, Value>,
  owner: object,
): SpatialNode<Key, Value> {
  const left = ownSpatialNode(node.left!, owner);
  node.left = left.right;
  left.right = updateHeight(node);
  return updateHeight(left);
}

function balance<Key, Value>(
  node: SpatialNode<Key, Value>,
  owner: object,
): SpatialNode<Key, Value> {
  updateHeight(node);
  const difference = height(node.left) - height(node.right);
  if (difference > 1) {
    const left = node.left!;
    if (height(left.left) < height(left.right))
      node.left = rotateLeft(ownSpatialNode(left, owner), owner);
    return rotateRight(node, owner);
  }
  if (difference < -1) {
    const right = node.right!;
    if (height(right.right) < height(right.left))
      node.right = rotateRight(ownSpatialNode(right, owner), owner);
    return rotateLeft(node, owner);
  }
  return node;
}

function setSpatialNode<Key, Value>(
  node: SpatialNode<Key, Value> | undefined,
  key: Key,
  value: Value,
  order: SpatialKeyOrder<Key>,
  change: { added: boolean },
  owner: object,
): SpatialNode<Key, Value> {
  if (node === undefined) {
    change.added = true;
    return createSpatialNode(key, value, owner);
  }
  const editable = ownSpatialNode(node, owner);
  const comparison = order.compare(key, node.key);
  if (comparison === 0) editable.value = value;
  else if (comparison < 0)
    editable.left = setSpatialNode(node.left, key, value, order, change, owner);
  else editable.right = setSpatialNode(node.right, key, value, order, change, owner);
  return balance(editable, owner);
}

function deleteSpatialNode<Key, Value>(
  node: SpatialNode<Key, Value> | undefined,
  key: Key,
  order: SpatialKeyOrder<Key>,
  change: { removed: boolean },
  owner: object,
): SpatialNode<Key, Value> | undefined {
  if (node === undefined) return undefined;
  const comparison = order.compare(key, node.key);
  const editable = ownSpatialNode(node, owner);
  if (comparison < 0) {
    editable.left = deleteSpatialNode(node.left, key, order, change, owner);
    return change.removed ? balance(editable, owner) : node;
  }
  if (comparison > 0) {
    editable.right = deleteSpatialNode(node.right, key, order, change, owner);
    return change.removed ? balance(editable, owner) : node;
  }
  change.removed = true;
  if (node.left === undefined) return node.right;
  if (node.right === undefined) return node.left;
  let successor = node.right;
  while (successor.left !== undefined) successor = successor.left;
  editable.key = successor.key;
  editable.value = successor.value;
  editable.right = deleteSpatialNode(node.right, successor.key, order, { removed: false }, owner);
  return balance(editable, owner);
}
