import type { DocumentWorkerBootstrap } from "./document-worker-entry";
import {
  decodeEmbeddedSource,
  isEmbeddedSourceWindow,
  type EmbeddedSourceWindow,
} from "./embedded-source";
import {
  WorkerDocumentRuntimePort,
  type WorkerBridgeEndpoint,
  type WorkerDocumentRuntimePortOptions,
} from "./worker-bridge";
import { DOCUMENT_WORKER_GZIP } from "./worker-source";
import type { DocumentRuntimePort } from "./types";

export interface WorkerWindow extends EmbeddedSourceWindow {
  readonly URL: {
    createObjectURL(object: Blob): string;
    revokeObjectURL(url: string): void;
  };
  readonly Worker: new (scriptURL: string | URL, options?: WorkerOptions) => WorkerBridgeEndpoint;
}

class OwnedWorkerEndpoint implements WorkerBridgeEndpoint {
  readonly #endpoint: WorkerBridgeEndpoint;
  readonly #releaseUrl: () => void;
  #terminated = false;

  public constructor(endpoint: WorkerBridgeEndpoint, releaseUrl: () => void) {
    this.#endpoint = endpoint;
    this.#releaseUrl = releaseUrl;
  }

  public addEventListener(type: "error", listener: () => void): void;
  public addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  public addEventListener(
    type: "error" | "message",
    listener: (() => void) | ((event: MessageEvent<unknown>) => void),
  ): void {
    if (type === "error") this.#endpoint.addEventListener(type, listener as () => void);
    else this.#endpoint.addEventListener(type, listener);
  }

  public postMessage(message: unknown, transfer?: Transferable[]): void {
    this.#endpoint.postMessage(message, transfer);
  }

  public removeEventListener(type: "error", listener: () => void): void;
  public removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  public removeEventListener(
    type: "error" | "message",
    listener: (() => void) | ((event: MessageEvent<unknown>) => void),
  ): void {
    if (type === "error") this.#endpoint.removeEventListener(type, listener as () => void);
    else this.#endpoint.removeEventListener(type, listener);
  }

  public terminate(): void {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#endpoint.terminate();
    this.#releaseUrl();
  }
}

export async function createDocumentRuntime(
  sessionId: string,
  workerEpoch: number,
  owningWindow: Window | WorkerWindow,
  options: WorkerDocumentRuntimePortOptions = {},
): Promise<DocumentRuntimePort> {
  const workerWindow = requireWorkerWindow(owningWindow);
  let objectUrl: string | undefined;
  let endpoint: OwnedWorkerEndpoint | undefined;
  try {
    const workerSource = await decodeDocumentWorkerSource(workerWindow);
    const source = new workerWindow.Blob([workerSource], { type: "text/javascript" });
    objectUrl = workerWindow.URL.createObjectURL(source);
    const worker = new workerWindow.Worker(objectUrl, {
      name: "inkbook-document-worker",
    });
    const workerUrl = objectUrl;
    endpoint = new OwnedWorkerEndpoint(worker, () => {
      workerWindow.URL.revokeObjectURL(workerUrl);
    });
    const ownedEndpoint = endpoint;
    const runtime = new WorkerDocumentRuntimePort(() => ownedEndpoint, options);
    endpoint.postMessage({
      sessionId,
      type: "inkbook-worker-bootstrap",
      workerEpoch,
    } satisfies DocumentWorkerBootstrap);
    return runtime;
  } catch (error) {
    if (endpoint !== undefined) endpoint.terminate();
    else if (objectUrl !== undefined) workerWindow.URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

async function decodeDocumentWorkerSource(workerWindow: WorkerWindow): Promise<string> {
  return decodeEmbeddedSource(DOCUMENT_WORKER_GZIP, workerWindow);
}

function requireWorkerWindow(value: unknown): WorkerWindow {
  if (!isWorkerWindow(value)) {
    throw new Error("The owning window does not provide the Worker and Blob URL APIs.");
  }
  return value;
}

function isWorkerWindow(value: unknown): value is WorkerWindow {
  return (
    isEmbeddedSourceWindow(value) &&
    "Worker" in value &&
    typeof value.Worker === "function" &&
    "URL" in value &&
    (typeof value.URL === "object" || typeof value.URL === "function") &&
    value.URL !== null &&
    "createObjectURL" in value.URL &&
    typeof value.URL.createObjectURL === "function" &&
    "revokeObjectURL" in value.URL &&
    typeof value.URL.revokeObjectURL === "function"
  );
}
