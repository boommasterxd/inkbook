type ObservedMethod = "get" | "getRank" | "materializeBandOrder";

/** Forward real Store access without Vitest's job-long WeakRef ownership of its target. */
export function observeSelectionStoreMethod<Target extends object>(
  target: Target,
  method: Extract<keyof Target, ObservedMethod>,
  onCall: () => void = () => undefined,
) {
  const original = target[method];
  if (typeof original !== "function") throw new TypeError("Expected a Store access method.");
  const descriptor = Object.getOwnPropertyDescriptor(target, method);
  const work = { calls: 0, lastArguments: undefined as readonly unknown[] | undefined };
  Object.defineProperty(target, method, {
    configurable: true,
    writable: true,
    value(this: Target, ...parameters: unknown[]): unknown {
      work.calls += 1;
      work.lastArguments = parameters;
      onCall();
      return Reflect.apply(original, this, parameters) as unknown;
    },
  });
  return {
    work,
    clear: () => {
      work.calls = 0;
      work.lastArguments = undefined;
    },
    restore: () => {
      if (descriptor === undefined) Reflect.deleteProperty(target, method);
      else Object.defineProperty(target, method, descriptor);
    },
  };
}
