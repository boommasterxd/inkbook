import { describe, expect, it, vi } from "vitest";

import {
  launchPhaseZeroWorker,
  PHASE_ZERO_WORKER_SOURCE,
  type BrowserWorkerEnvironment,
} from "../../../src/workers/phase-zero";

let blobConstructionFails = false;

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
      createObjectURL: (): string => "blob:inkbook-phase-zero",
      revokeObjectURL,
    },
    Worker: TestWorker,
  } as unknown as BrowserWorkerEnvironment;
}

describe("phase-zero browser worker adapter", () => {
  it("keeps the worker implementation as a local immutable static payload", () => {
    expect(typeof PHASE_ZERO_WORKER_SOURCE).toBe("string");
    expect(PHASE_ZERO_WORKER_SOURCE).toContain('"use strict"');
    expect(PHASE_ZERO_WORKER_SOURCE).not.toMatch(
      /\b(?:eval|importScripts|Obsidian|https?:)\b/u,
    );
  });

  it("launches from a Blob URL and revokes the URL exactly once on disposal", () => {
    const revoke = vi.fn<(url: string) => void>();
    const launched = launchPhaseZeroWorker(environment(revoke));

    expect(launched).toBeDefined();
    launched?.dispose();
    launched?.dispose();

    const worker = launched?.worker as unknown as TestWorker;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:inkbook-phase-zero");
  });

  it("revokes a created URL when worker construction is unavailable", () => {
    const revoke = vi.fn<(url: string) => void>();
    workerConstructionFails = true;

    expect(launchPhaseZeroWorker(environment(revoke))).toBeUndefined();
    expect(revoke).toHaveBeenCalledOnce();
    workerConstructionFails = false;
  });

  it("reports unavailability without revocation when Blob creation fails", () => {
    const revoke = vi.fn<(url: string) => void>();
    blobConstructionFails = true;

    expect(launchPhaseZeroWorker(environment(revoke))).toBeUndefined();
    expect(revoke).not.toHaveBeenCalled();
    blobConstructionFails = false;
  });
});
