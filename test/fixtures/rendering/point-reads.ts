/** Observes indexed sample reads without changing the source array or its identity semantics. */
export function observePointReads(points: number[], onRead: () => void): number[] {
  return new Proxy(points, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) onRead();
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
}
