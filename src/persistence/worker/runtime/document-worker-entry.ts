import { createProductionDocumentRuntime } from "./production-document-runtime";
import { attachDocumentWorkerHost, type WorkerHostEndpoint } from "./bridge/worker-host";
import { createWorkerWorkScheduler } from "./worker-work-scheduler";

export interface DocumentWorkerBootstrap {
  readonly frameIntervalMilliseconds: number;
  readonly sessionId: string;
  readonly sliceMilliseconds: number;
  readonly type: "inkbook-worker-bootstrap";
  readonly workerEpoch: number;
}

const endpoint = self as unknown as WorkerHostEndpoint;

const bootstrap = (event: MessageEvent<unknown>): void => {
  if (!isBootstrap(event.data)) return;
  endpoint.removeEventListener("message", bootstrap);
  const scheduling = createWorkerWorkScheduler(event.data);
  attachDocumentWorkerHost(
    endpoint,
    createProductionDocumentRuntime(
      {
        sessionId: event.data.sessionId,
        workerEpoch: event.data.workerEpoch,
      },
      scheduling,
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
    Number.isSafeInteger(value.workerEpoch) &&
    "sliceMilliseconds" in value &&
    typeof value.sliceMilliseconds === "number" &&
    Number.isFinite(value.sliceMilliseconds) &&
    value.sliceMilliseconds > 0 &&
    "frameIntervalMilliseconds" in value &&
    typeof value.frameIntervalMilliseconds === "number" &&
    Number.isFinite(value.frameIntervalMilliseconds) &&
    value.frameIntervalMilliseconds > 0
  );
}
