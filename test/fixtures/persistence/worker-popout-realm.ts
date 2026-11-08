import { runInNewContext } from "node:vm";

import { vi } from "vitest";

import { TestWorkerEndpoint } from "./worker-endpoint";

/** Worker messages deserialize in the worker constructor's owning window realm. */
export function installPopoutWorkerTransport(endpoint: TestWorkerEndpoint) {
  const constructors = runInNewContext(
    "({ Array, Object, Float64Array, Uint8Array, Uint32Array })",
  ) as {
    Array: typeof Array;
    Object: typeof Object;
    Float64Array: typeof Float64Array;
    Uint8Array: typeof Uint8Array;
    Uint32Array: typeof Uint32Array;
  };
  const receivedBuffers: ArrayBuffer[] = [];
  const deliver = endpoint.postMessage.bind(endpoint);
  endpoint.cloneTransfers = false;
  vi.spyOn(endpoint, "postMessage").mockImplementation((message, transfer = []) => {
    const received: unknown = structuredClone(message, { transfer });
    deliver(popoutValues(received), transfer);
  });
  return receivedBuffers;

  function popoutValues(value: unknown): unknown {
    if (
      value instanceof Float64Array ||
      value instanceof Uint8Array ||
      value instanceof Uint32Array
    ) {
      const received =
        value instanceof Float64Array
          ? new constructors.Float64Array(value)
          : value instanceof Uint8Array
            ? new constructors.Uint8Array(value)
            : new constructors.Uint32Array(value);
      receivedBuffers.push(received.buffer);
      return received;
    }
    if (Array.isArray(value)) return constructors.Array.from(value, popoutValues);
    if (typeof value !== "object" || value === null) return value;
    return constructors.Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, popoutValues(entry)]),
    );
  }
}
