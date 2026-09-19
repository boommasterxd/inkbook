/** Observes production indexed reads, including JSON descriptor-based inspection. */
export function observeSchemaArray<T>(values: T[]) {
  const work = { indexedReads: 0, descriptorReads: 0 };
  const observed = new Proxy(values, {
    get(target, key, receiver): unknown {
      if (isIndex(key)) work.indexedReads += 1;
      return Reflect.get(target, key, receiver) as unknown;
    },
    getOwnPropertyDescriptor(target, key) {
      if (isIndex(key)) work.descriptorReads += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  return { observed, work };
}

function isIndex(key: string | symbol): boolean {
  return typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key);
}
