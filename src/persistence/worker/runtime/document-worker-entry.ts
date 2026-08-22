import { createProductionDocumentRuntime } from "./production-document-runtime";
import { attachDocumentWorkerHost, type WorkerHostEndpoint } from "./worker-host";

export interface DocumentWorkerBootstrap {
  readonly sessionId: string;
  readonly type: "inkbook-worker-bootstrap";
  readonly workerEpoch: number;
}

const endpoint = self as unknown as WorkerHostEndpoint;

const bootstrap = (event: MessageEvent<unknown>): void => {
  if (!isBootstrap(event.data)) return;
  endpoint.removeEventListener("message", bootstrap);
  attachDocumentWorkerHost(
    endpoint,
    createProductionDocumentRuntime(
      {
        sessionId: event.data.sessionId,
        workerEpoch: event.data.workerEpoch,
      },
      { yieldControl: () => new Promise((resolve) => endpoint.setTimeout(resolve, 0)) },
    ),
  );
};

endpoint.addEventListener("message", bootstrap);

function isBootstrap(value: unknown): value is DocumentWorkerBootstrap {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "inkbook-worker-bootstrap" &&
    "sessionId" in value &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    "workerEpoch" in value &&
    Number.isSafeInteger(value.workerEpoch)
  );
}
