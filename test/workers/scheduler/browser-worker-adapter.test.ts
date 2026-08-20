import { describe, expect, it, vi } from "vitest";

import {
  launchByteWorker,
  type BrowserWorkerEnvironment,
} from "../../../src/workers/scheduler";

const STATIC_WORKER_SOURCE = '"use strict";';

let blobConstructionFails = false;
let lastBlobParts: readonly BlobPart[] = [];
let lastBlobType = "";

class TestBlob {
  public readonly parts: readonly BlobPart[];
  public readonly type: string;

  public constructor(
    parts: readonly BlobPart[] = [],
    options: BlobPropertyBag = {},
  ) {
    if (blobConstructionFails) throw new Error("blob unavailable");
    this.parts = parts;
    this.type = options.type ?? "";
    lastBlobParts = parts;
    lastBlobType = this.type;
  }
}

let workerConstructionFails = false;

class TestWorker {
  public readonly scriptUrl: string | URL;
  public terminate = vi.fn<() => void>();

  public constructor(scriptUrl: string | URL) {
    if (workerConstructionFails) throw new Error("unavailable");
    this.scriptUrl = scriptUrl;
  }
}

function environment(
  revokeObjectURL: (url: string) => void,
): BrowserWorkerEnvironment {
  return {
    Blob: TestBlob,
    URL: {
      createObjectURL: (): string => "blob:inkbook-byte-worker",
      revokeObjectURL,
    },
    Worker: TestWorker,
  } as unknown as BrowserWorkerEnvironment;
}

describe("browser worker adapter", () => {
  it("launches caller-owned static source and revokes the URL once", () => {
    const revoke = vi.fn<(url: string) => void>();
    const launched = launchByteWorker(
      environment(revoke),
      STATIC_WORKER_SOURCE,
    );

    expect(launched).toBeDefined();
    expect(lastBlobParts).toEqual([STATIC_WORKER_SOURCE]);
    expect(lastBlobType).toBe("text/javascript");
    launched?.dispose();
    launched?.dispose();

    const worker = launched?.worker as unknown as TestWorker;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:inkbook-byte-worker");
  });

  it("revokes a created URL when worker construction is unavailable", () => {
    const revoke = vi.fn<(url: string) => void>();
    workerConstructionFails = true;

    expect(
      launchByteWorker(environment(revoke), STATIC_WORKER_SOURCE),
    ).toBeUndefined();
    expect(revoke).toHaveBeenCalledOnce();
    workerConstructionFails = false;
  });

  it("reports unavailability without revocation when Blob creation fails", () => {
    const revoke = vi.fn<(url: string) => void>();
    blobConstructionFails = true;

    expect(
      launchByteWorker(environment(revoke), STATIC_WORKER_SOURCE),
    ).toBeUndefined();
    expect(revoke).not.toHaveBeenCalled();
    blobConstructionFails = false;
  });
});
