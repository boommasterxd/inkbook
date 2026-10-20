import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../../src/persistence/worker/runtime/worker-source", () => ({
  DOCUMENT_WORKER_GZIP:
    "<Ah!!!!!9-SOx5;6=n}85SXsqn,*>3h^H>}Exb9V{|jvA7Y:d=.UqU,ZbU-W<0z#{mr4#O5Q(g)*!!!!",
}));

import { createDocumentRuntime } from "../../../../../src/persistence/worker/runtime/public";
import { type WorkerWindow } from "../../../../../src/persistence/worker/runtime/worker-factory";
import { createTestWorkScheduler } from "../../../../fixtures/persistence/work-scheduler";
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
  it("bootstraps named workers and releases each worker and URL once across repeated cycles", async () => {
    FakeWorker.instances = [];
    FakeWorker.constructionError = undefined;
    const { blobs, owningWindow, revoked } = createWindow();

    for (let cycle = 0; cycle < 25; cycle += 1) {
      const runtime = await createDocumentRuntime(
        `session-${String(cycle)}`,
        cycle + 1,
        owningWindow,
        { workScheduler: createTestWorkScheduler(), frameIntervalMilliseconds: () => 10 },
      );
      expect(FakeWorker.instances[cycle]?.options).toEqual({ name: "inkbook-document-worker" });
      expect(FakeWorker.instances[cycle]?.sentMessages).toEqual([
        {
          frameIntervalMilliseconds: 10,
          sessionId: `session-${String(cycle)}`,
          sliceMilliseconds: 8,
          type: "inkbook-worker-bootstrap",
          workerEpoch: cycle + 1,
        },
      ]);
      runtime.terminate();
      runtime.terminate();
      expect(revoked).toHaveLength(cycle + 1);
    }

    expect(FakeWorker.instances).toHaveLength(25);
    expect(FakeWorker.instances.every(({ terminated }) => terminated)).toBe(true);
    expect(revoked).toHaveLength(25);
    const workerBlob = blobs[0];
    if (workerBlob === undefined) throw new Error("Expected a worker Blob.");
    await expect(workerBlob.text()).resolves.toContain("inkbook-worker-bootstrap");
    expect(revoked.every((url) => url === "blob:inkbook-worker")).toBe(true);
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
      createDocumentRuntime(
        "session-a",
        1,
        {
          ...owningWindow,
          DecompressionStream: FailingDecompressionStream,
        },
        { workScheduler: createTestWorkScheduler(), frameIntervalMilliseconds: () => 1_000 / 60 },
      ),
    ).rejects.toThrow("unsupported compression stream");
    expect(FakeWorker.instances).toHaveLength(0);
    expect(revoked).toEqual([]);
  });

  it("revokes the Blob URL and rethrows a CSP construction failure", async () => {
    FakeWorker.instances = [];
    FakeWorker.constructionError = new Error("blocked by worker-src");
    const { owningWindow, revoked } = createWindow();

    await expect(
      createDocumentRuntime("session-a", 1, owningWindow, {
        workScheduler: createTestWorkScheduler(),
        frameIntervalMilliseconds: () => 1_000 / 60,
      }),
    ).rejects.toThrow("blocked by worker-src");
    expect(FakeWorker.instances).toHaveLength(0);
    expect(revoked).toEqual(["blob:inkbook-worker"]);
    FakeWorker.constructionError = undefined;
  });
});
