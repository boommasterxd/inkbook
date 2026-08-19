import { PHASE_ZERO_WORKER_SOURCE } from "./worker-source";

const WORKER_MIME_TYPE = "text/javascript";
const WORKER_NAME = "inkbook-phase-zero";

export interface BrowserWorkerEnvironment {
  readonly Blob: new (
    blobParts?: BlobPart[],
    options?: BlobPropertyBag,
  ) => Blob;
  readonly URL: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
  readonly Worker: new (
    scriptURL: string | URL,
    options?: WorkerOptions,
  ) => Worker;
}

export interface LaunchedBrowserWorker {
  readonly worker: Worker;
  dispose(): void;
}

export function launchPhaseZeroWorker(
  environment: BrowserWorkerEnvironment,
): LaunchedBrowserWorker | undefined {
  let objectUrl: string | undefined;
  try {
    const blob = new environment.Blob([PHASE_ZERO_WORKER_SOURCE], {
      type: WORKER_MIME_TYPE,
    });
    objectUrl = environment.URL.createObjectURL(blob);
    const workerUrl = objectUrl;
    const worker = new environment.Worker(workerUrl, { name: WORKER_NAME });
    let disposed = false;
    return {
      worker,
      dispose: (): void => {
        if (disposed) return;
        disposed = true;
        worker.terminate();
        environment.URL.revokeObjectURL(workerUrl);
      },
    };
  } catch {
    if (objectUrl !== undefined) environment.URL.revokeObjectURL(objectUrl);
    return undefined;
  }
}
