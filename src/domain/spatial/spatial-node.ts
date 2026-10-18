export interface SpatialNode<Key, Value> {
  readonly owner: object;
  key: Key;
  value: Value;
  height: number;
  left: SpatialNode<Key, Value> | undefined;
  right: SpatialNode<Key, Value> | undefined;
}

export function createSpatialNode<Key, Value>(
  key: Key,
  value: Value,
  owner: object,
): SpatialNode<Key, Value> {
  return { key, value, owner, height: 1, left: undefined, right: undefined };
}

/** A revoked token leaves every previously shared node immutable to both fork owners. */
export function copySpatialNode<Key, Value>(
  node: SpatialNode<Key, Value>,
  owner: object,
): SpatialNode<Key, Value> {
  return { ...node, owner };
}
