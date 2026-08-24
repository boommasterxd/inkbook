import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../../src/persistence/worker/runtime/worker-source", () => ({
  DOCUMENT_WORKER_GZIP:
    "<Ah!!!!!9-SOx5;6=n}85SXsqn,*>3h^H>}Exb9V{|jvA7Y:d=.UqU,ZbU-W<0z#{mr4#O5Q(g)*!!!!",
}));

import {
  createDocumentRuntime,
  type WorkerWindow,
} from "../../../../../src/persistence/worker/runtime/public";
import { TestWorkerEndpoint } from "../../../../fixtures/persistence/worker-endpoint";

class FakeWorker extends TestWorkerEndpoint {
  static constructionError: Error | undefined;
  static instances: FakeWorker[] = [];

  readonly options: WorkerOptions | undefined;
  readonly scriptUrl: string | URL;

  public constructor(scriptUrl: string | URL, options?: WorkerOptions) {
    if (FakeWorker.constructionError !== undefined) throw FakeWorker.constructionError;
    super();
    this.options = options;
    this.scriptUrl = scriptUrl;
    FakeWorker.instances.push(this);
  }
}

function createWindow() {
  const blobs: Blob[] = [];
  const revoked: string[] = [];
  const objectUrlApi = Object.assign(function URL() {}, {
    createObjectURL: (blob: Blob) => {
      blobs.push(blob);
      return "blob:inkbook-worker";
    },
    revokeObjectURL: (url: string) => revoked.push(url),
  });
  const owningWindow: WorkerWindow = {
    Blob,
    DecompressionStream,
    Response,
    URL: objectUrlApi,
    Worker: FakeWorker,
  };
  return { blobs, owningWindow, revoked };
}

describe("production document worker factory", () => {
  it("releases workers and owned URLs across repeated runtime cycles", async () => {
    FakeWorker.instances = [];
    FakeWorker.constructionError = undefined;
    const { owningWindow, revoked } = createWindow();

    for (let cycle = 0; cycle < 25; cycle += 1) {
      const runtime = await createDocumentRuntime(
        `session-${String(cycle)}`,
        cycle + 1,
        owningWindow,
      );
      runtime.terminate();
    }

    expect(FakeWorker.instances).toHaveLength(25);
    expect(FakeWorker.instances.every(({ terminated }) => terminated)).toBe(true);
    expect(revoked).toHaveLength(25);
  });

  it("creates one named worker and releases its Blob URL exactly once", async () => {
    FakeWorker.instances = [];
    FakeWorker.constructionError = undefined;
    const { blobs, owningWindow, revoked } = createWindow();

    const runtime = await createDocumentRuntime("session-a", 3, owningWindow);

    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]?.options).toEqual({ name: "inkbook-document-worker" });
    expect(FakeWorker.instances[0]?.sentMessages).toEqual([
      { sessionId: "session-a", type: "inkbook-worker-bootstrap", workerEpoch: 3 },
    ]);
    const workerBlob = blobs[0];
    if (workerBlob === undefined) throw new Error("Expected a worker Blob.");
    await expect(workerBlob.text()).resolves.toContain("inkbook-worker-bootstrap");
    runtime.terminate();
    runtime.terminate();
    expect(FakeWorker.instances[0]?.terminated).toBe(true);
    expect(revoked).toEqual(["blob:inkbook-worker"]);
  });

  it("rejects decompression errors before constructing a worker or Blob URL", async () => {
    class FailingDecompressionStream extends DecompressionStream {
      public constructor(format: CompressionFormat) {
        super(format);
        throw new Error("unsupported compression stream");
      }
    }

    FakeWorker.instances = [];
    const { owningWindow, revoked } = createWindow();

    await expect(
      createDocumentRuntime("session-a", 1, {
        ...owningWindow,
        DecompressionStream: FailingDecompressionStream,
      }),
    ).rejects.toThrow("unsupported compression stream");
    expect(FakeWorker.instances).toHaveLength(0);
    expect(revoked).toEqual([]);
  });

  it("revokes the Blob URL and rethrows a CSP construction failure", async () => {
    FakeWorker.instances = [];
    FakeWorker.constructionError = new Error("blocked by worker-src");
    const { owningWindow, revoked } = createWindow();

    await expect(createDocumentRuntime("session-a", 1, owningWindow)).rejects.toThrow(
      "blocked by worker-src",
    );
    expect(FakeWorker.instances).toHaveLength(0);
    expect(revoked).toEqual(["blob:inkbook-worker"]);
    FakeWorker.constructionError = undefined;
  });
});
