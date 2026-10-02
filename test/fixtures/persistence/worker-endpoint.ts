import { type WorkerBridgeEndpoint } from "../../../src/persistence/worker/runtime/worker-bridge";
import { type WorkerHostEndpoint } from "../../../src/persistence/worker/runtime/worker-host";

export class TestWorkerEndpoint implements WorkerBridgeEndpoint, WorkerHostEndpoint {
  peer: TestWorkerEndpoint | null = null;
  readonly sentMessages: unknown[] = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;
  public cloneTransfers = false;
  readonly #listeners = {
    error: new Set<() => void>(),
    message: new Set<(event: MessageEvent<unknown>) => void>(),
  };
  readonly #timeouts = new Map<symbol, { callback: () => void; milliseconds: number }>();

  public addEventListener(
    type: "error" | "message",
    listener: (() => void) | ((event: MessageEvent<unknown>) => void),
  ): void {
    if (type === "error") this.#listeners.error.add(listener as () => void);
    else this.#listeners.message.add(listener);
  }

  public clearTimeout(handle: unknown): void {
    if (typeof handle === "symbol") this.#timeouts.delete(handle);
  }

  public fireTimeouts(minimumMilliseconds = 0): void {
    for (const [handle, timeout] of this.#timeouts) {
      if (timeout.milliseconds < minimumMilliseconds) continue;
      this.#timeouts.delete(handle);
      timeout.callback();
    }
  }

  public postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.sentMessages.push(message);
    this.transfers.push(transfer);
    const listeners = this.peer === null ? [] : this.peer.#listeners.message;
    const data = this.cloneTransfers ? structuredClone(message, { transfer }) : message;
    for (const listener of listeners) listener({ data } as MessageEvent<unknown>);
  }

  public removeEventListener(
    type: "error" | "message",
    listener: (() => void) | ((event: MessageEvent<unknown>) => void),
  ): void {
    if (type === "error") this.#listeners.error.delete(listener as () => void);
    else this.#listeners.message.delete(listener);
  }

  public setTimeout(callback: () => void, milliseconds: number): unknown {
    const handle = Symbol("test-worker-timeout");
    this.#timeouts.set(handle, { callback, milliseconds });
    if (milliseconds === 0) {
      queueMicrotask(() => {
        if (!this.#timeouts.delete(handle)) return;
        callback();
      });
    }
    return handle;
  }

  public terminate(): void {
    this.terminated = true;
  }
}
