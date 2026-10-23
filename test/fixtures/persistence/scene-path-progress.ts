import { DocumentWorkerRuntime } from "../../../src/persistence/worker/runtime/document-runtime";
import type { DocumentRuntimeObserver } from "../../../src/persistence/worker/runtime/types";
import { attachDocumentWorkerHost } from "../../../src/persistence/worker/runtime/bridge/worker-host";
import { createWorkerBridgeClient, createWorkerBridgeEndpoints } from "./worker-bridge";
import { createTestStroke, createWorkerSnapshot } from "./worker-snapshot";

export const scenePathProgressIdentity = {
  sessionId: "session-a",
  workerEpoch: 1,
  operationId: 2,
  purpose: "background" as const,
};

interface ScenePathProgressFixtureOptions {
  readonly initiallyBlocked?: boolean;
  readonly navigationReserve?: boolean;
  readonly speculative?: boolean;
  readonly visibleCount?: number;
}

/** Fresh capacity-sized model, central admission controls, and owned bridge ACK lifecycle. */
export async function createScenePathProgressFixture(
  bridge: boolean,
  options: ScenePathProgressFixtureOptions = {},
) {
  let runtime!: DocumentWorkerRuntime;
  const control = progressAdmission(
    () => runtime.instrumentation.shapeBuilds,
    options.initiallyBlocked ?? true,
  );
  runtime = new DocumentWorkerRuntime(scenePathProgressIdentity, control.scheduler);
  const endpoints = createWorkerBridgeEndpoints();
  const detach = attachDocumentWorkerHost(endpoints.hostEndpoint, runtime);
  const rejection = scenePathDeferred();
  const observeAcknowledgement = (event: MessageEvent<unknown>): void => {
    const message = event.data as { type: string; accepted?: boolean };
    if (message.type === "inkbook-worker-batch-acknowledgement" && message.accepted === false)
      rejection.resolve();
  };
  endpoints.hostEndpoint.addEventListener("message", observeAcknowledgement);
  const port = bridge ? createWorkerBridgeClient(endpoints.clientEndpoint) : runtime;
  const elements = Array.from({ length: 256 }, (_, index) => ({
    ...createTestStroke(),
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  }));
  const snapshot = createWorkerSnapshot(elements);
  await port.execute({
    baseModelRevision: null,
    identity: scenePathProgressIdentity,
    modelRevision: 0,
    snapshot,
    type: "model-sync-full",
  });
  const ids = elements.map(({ id }) => id);
  const messages = () =>
    endpoints.hostEndpoint.sentMessages.filter(
      (message) => (message as { type: string }).type === "inkbook-worker-scene-paths",
    );
  return {
    ...control,
    ids,
    snapshot,
    lastId: ids[ids.length - 1]!,
    port,
    runtime,
    prepare: (scenePaths: NonNullable<DocumentRuntimeObserver["scenePaths"]>, maxBytes?: number) =>
      port.execute(
        {
          basisRevision: 0,
          identity: scenePathProgressIdentity,
          ids,
          streamProgress: true,
          ...(options.navigationReserve ? { navigationReserve: true, speculative: true } : {}),
          ...(options.speculative ? { speculative: true } : {}),
          type: "prepare-scene-paths",
          ...(options.visibleCount === undefined ? {} : { visibleCount: options.visibleCount }),
          ...(maxBytes === undefined ? {} : { maxBytes }),
        },
        { unlockBatch: () => undefined, scenePaths },
      ),
    rejectedAcknowledgement: rejection.promise,
    progressMessages: () => messages().length,
    sentIds: (batches: string[][]): string[] =>
      bridge
        ? messages().flatMap((message) => {
            const batch = message as { batch: { paths: readonly { id: string }[] } };
            return batch.batch.paths.map(({ id }) => id);
          })
        : batches.flat(),
    close: () => {
      endpoints.hostEndpoint.removeEventListener("message", observeAcknowledgement);
      port.terminate();
      detach();
    },
  };
}

export function scenePathProgressCases<T extends string>(
  ...terminals: readonly T[]
): Array<readonly [boolean, T]> {
  return [false, true].flatMap((bridge) =>
    terminals.map((terminal) => [bridge, terminal] as const),
  );
}

export function scenePathDeferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((ready, fail) => {
    resolve = ready;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function progressAdmission(shapeBuilds: () => number, initiallyBlocked: boolean) {
  let blocked = initiallyBlocked;
  let admissionsHeld = false;
  let handoffs = 0;
  const handoff = scenePathDeferred();
  const admission = scenePathDeferred();
  const requested = scenePathDeferred();
  return {
    scheduler: {
      checkpoint: (signal: AbortSignal) => {
        if (admissionsHeld) {
          requested.resolve();
          return cancellableAdmission(admission.promise, signal);
        }
        if (!blocked || shapeBuilds() !== 1) return undefined;
        handoffs++;
        return cancellableAdmission(handoff.promise, signal);
      },
      run: async <T>(
        operation: (signal: AbortSignal) => T | Promise<T>,
        signal: AbortSignal,
      ): Promise<T> => operation(signal),
    },
    admissionRequested: requested.promise,
    holdAdmissions: () => {
      admissionsHeld = true;
    },
    releaseAdmissions: () => {
      admissionsHeld = false;
      admission.resolve();
    },
    handoffs: () => handoffs,
    resume: () => {
      blocked = false;
      handoff.resolve();
    },
  };
}

function cancellableAdmission(admission: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => reject(new Error("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    void admission.then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
  });
}
