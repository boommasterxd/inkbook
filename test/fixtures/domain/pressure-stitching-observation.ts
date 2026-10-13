/** Observe bucket ownership through actual container publication, independently of lookup keys. */
export function observePressureStitchBuckets() {
  const buckets = new Set<Map<unknown, unknown>>();
  const lookups: { receiver: Map<unknown, unknown>; key: unknown }[] = [];
  const getDescriptor = Object.getOwnPropertyDescriptor(Map.prototype, "get")!;
  const setDescriptor = Object.getOwnPropertyDescriptor(Map.prototype, "set")!;
  const originalGet = getDescriptor.value as Map<unknown, unknown>["get"];
  const originalSet = setDescriptor.value as Map<unknown, unknown>["set"];
  const get = function (this: Map<unknown, unknown>, key: unknown) {
    lookups.push({ receiver: this, key });
    return Reflect.apply(originalGet, this, [key]);
  };
  const set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
    const result = Reflect.apply(originalSet, this, [key, value]);
    if (value instanceof Map) {
      buckets.add(this);
      buckets.add(value);
    } else if (Array.isArray(value) && value.every((index: unknown) => typeof index === "number"))
      buckets.add(this);
    return result;
  };
  Object.defineProperty(Map.prototype, "get", { ...getDescriptor, value: get });
  Object.defineProperty(Map.prototype, "set", { ...setDescriptor, value: set });
  return {
    keys: () => lookups.filter(({ receiver }) => buckets.has(receiver)).map(({ key }) => key),
    restore: () => {
      Object.defineProperty(Map.prototype, "get", getDescriptor);
      Object.defineProperty(Map.prototype, "set", setDescriptor);
    },
  };
}
