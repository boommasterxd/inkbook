import { afterEach, describe, expect, it, vi } from "vitest";

import { createSharedWorkerPortsV1 } from "../../src/workers/shared-worker-ports";
import { readStaticSharedWorkerSource } from "../../src/workers/static-worker-source";
import type { BrowserWorkerEnvironment } from "../../src/workers/scheduler/browser-worker-adapter";
import type { ByteWorkerRequest } from "../../src/workers/scheduler/protocol";
import { ManualSlices } from "./scheduler/support";

class BootstrapWorker extends EventTarget {
  readonly posted: ByteWorkerRequest[] = [];
  terminate = vi.fn<() => void>();

  postMessage(message: ByteWorkerRequest): void {
    this.posted.push(message);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("static worker bootstrap branches", () => {
  it("fails closed when the build-time worker payload is absent or empty", () => {
    vi.stubGlobal("__INKBOOK_STATIC_WORKER_SOURCE__", undefined);
    expect(() => readStaticSharedWorkerSource()).toThrow("unavailable");
    vi.stubGlobal("__INKBOOK_STATIC_WORKER_SOURCE__", "");
    expect(() => readStaticSharedWorkerSource()).toThrow("unavailable");
  });

  it("launches the non-empty static payload through the shared worker ports", async () => {
    vi.stubGlobal("__INKBOOK_STATIC_WORKER_SOURCE__", '"use strict";');
    const worker = new BootstrapWorker();
    const revoke = vi.fn<(url: string) => void>();
    const WorkerConstructor = function (): BootstrapWorker {
      return worker;
    } as unknown as BrowserWorkerEnvironment["Worker"];
    const environment = {
      Blob,
      URL: {
        createObjectURL: (): string => "blob:inkbook-shared-worker",
        revokeObjectURL: revoke,
      },
      Worker: WorkerConstructor,
    } as unknown as BrowserWorkerEnvironment;
    const ports = createSharedWorkerPortsV1({
      environment,
      clock: { now: (): number => 0 },
      slices: new ManualSlices(),
      readRevision: () => ({ scene: 1, layout: 1 }),
      isCurrent: (): boolean => true,
    });
    const digest = ports.sourceDigest.submit();
    expect(worker.posted[0]).toMatchObject({
      kind: "process-structured",
      workKind: "source-digest",
    });
    digest.cancel();
    ports.dispose();
    await expect(digest.completion).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:inkbook-shared-worker");
  });
});
