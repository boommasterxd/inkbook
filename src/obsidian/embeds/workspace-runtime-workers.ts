import {
  FRAME_WORK_SHARE,
  SchedulerDisposedError,
  type FrameCancellation,
  type WorkScheduler,
} from "../../domain/scheduling/work-scheduler";
import {
  createDocumentRuntime,
  DocumentWorkerRuntime,
  GestureAwareSliceScheduler,
} from "../../persistence/worker/runtime/public";
import type { DocumentRuntimeFactories } from "./document-model-port";
import {
  clearWindowTimeout,
  isWindowTimeoutHandle,
  type WindowTimeoutHandle,
} from "./workspace-runtime-lifecycle";
import { createWindowSchedulerForwarding } from "../performance/window-scheduler-forwarding";
import type { FileManager, Vault } from "obsidian";
import type { WorkerRuntimeFailure } from "../../persistence/worker/runtime/worker-bridge-contracts";
import { VaultDocumentSessionFactory } from "./vault-document-session-factory";
import type { VaultDocumentSessionHooks } from "./vault-document-recovery";
import type { WorkspaceRefreshProfiles } from "./workspace-refresh-profiles";

interface WorkspaceRuntimeWindowPorts {
  readonly fallbackWindow: () => Window | undefined;
  readonly owningWindow: (documentId: string) => Window;
  readonly workScheduler: (ownerWindow: Window) => WorkScheduler;
  readonly subscribeSchedulingProfile: (listener: () => void) => () => void;
  readonly warn?: (ownerWindow: Window | undefined, message: string) => void;
}

const DOCUMENT_RUNTIME_TIMEOUT_MS = 30_000;
const WORKER_FALLBACK_WARNING =
  "Inkbook: Document Worker unavailable or failed; using the bounded main-thread fallback. Performance may be reduced.";

export function createWorkspaceSessionFactory(options: {
  readonly vault: Vault;
  readonly fileManager: FileManager;
  readonly profiles: WorkspaceRefreshProfiles;
  readonly owningWindow: WorkspaceRuntimeWindowPorts["owningWindow"];
  readonly fallbackWindow: WorkspaceRuntimeWindowPorts["fallbackWindow"];
  readonly hooks: VaultDocumentSessionHooks;
}): VaultDocumentSessionFactory {
  return new VaultDocumentSessionFactory(
    options.vault,
    options.fileManager,
    createWorkspaceDocumentRuntimes({
      owningWindow: options.owningWindow,
      fallbackWindow: options.fallbackWindow,
      workScheduler: (window) => options.profiles.workScheduler(window),
      subscribeSchedulingProfile: (listener) => options.profiles.subscribe(listener),
    }),
    options.hooks,
  );
}

export function createWorkspaceDocumentRuntimes(
  windows: WorkspaceRuntimeWindowPorts,
): DocumentRuntimeFactories {
  const warnFallback = createFallbackWarning(windows);
  const workScheduler = (documentId: string): WorkScheduler =>
    createDocumentScheduler(() => windows.workScheduler(windows.owningWindow(documentId)));
  return {
    workScheduler,
    clock: (documentId) => ({
      clearTimeout: (handle) => {
        if (isWindowTimeoutHandle(handle)) clearWindowTimeout(handle);
      },
      setTimeout: (callback, milliseconds) => {
        const ownerWindow = windows.owningWindow(documentId);
        return {
          handle: ownerWindow.setTimeout(callback, milliseconds),
          ownerWindow: new WeakRef(ownerWindow),
        } satisfies WindowTimeoutHandle;
      },
    }),
    create: (sessionId, workerEpoch, documentId) =>
      createWorkspaceWorker(
        windows,
        { sessionId, workerEpoch, documentId },
        workScheduler(documentId),
      ),
    createFallback: (sessionId, workerEpoch, isInputActive, documentId) => {
      warnFallback();
      return new DocumentWorkerRuntime(
        { sessionId, workerEpoch },
        new GestureAwareSliceScheduler({
          isInputActive,
          workScheduler: workScheduler(documentId),
        }),
      );
    },
    createStoreScheduler: (documentId, isCancelled, priority = "background") => {
      const scheduler = workScheduler(documentId);
      return {
        isCancelled,
        shouldYield: () => scheduler.shouldYield(),
        yieldControl: () => {
          if (priority === "frame") {
            return scheduler.shouldYield()
              ? scheduler.nextFrame(undefined, "frame")
              : Promise.resolve();
          }
          return scheduler.checkpoint() ?? Promise.resolve();
        },
      };
    },
    now: (documentId) => {
      const performance = windows.owningWindow(documentId).performance;
      return Math.floor(performance.timeOrigin + performance.now());
    },
  };
}

async function createWorkspaceWorker(
  windows: WorkspaceRuntimeWindowPorts,
  identity: {
    readonly sessionId: string;
    readonly workerEpoch: number;
    readonly documentId: string;
  },
  scheduler: WorkScheduler,
): Promise<import("../../persistence/worker/runtime/types").DocumentRuntimePort> {
  const { sessionId, workerEpoch, documentId } = identity;
  try {
    const ownerWindow = windows.owningWindow(documentId);
    return await createDocumentRuntime(sessionId, workerEpoch, ownerWindow, {
      workScheduler: scheduler,
      frameIntervalMilliseconds: () => scheduler.budgetMs() / FRAME_WORK_SHARE,
      requestTimeoutMilliseconds: DOCUMENT_RUNTIME_TIMEOUT_MS,
      subscribeSchedulingProfile: windows.subscribeSchedulingProfile,
      // The plugin realm outlives presentation transfers and closed pop-out windows.
      requestTimeoutNow: () => performance.now(),
      onExecutorFailure: (failure) =>
        warnWorkerFailure(windows, {
          sessionId,
          workerEpoch,
          kind: failure.kind,
          phase: failure.phase,
          ...(failure.errorName === undefined ? {} : { errorName: failure.errorName }),
          ...(failure.request === undefined ? {} : { request: failure.request }),
        }),
    });
  } catch (error) {
    warnWorkerFailure(windows, {
      sessionId,
      workerEpoch,
      kind: "error",
      phase: "construction",
      errorName: workerErrorName(error),
    });
    throw error;
  }
}

function warnWorkerFailure(
  windows: WorkspaceRuntimeWindowPorts,
  failure: Omit<WorkerRuntimeFailure, "errorName"> & {
    readonly sessionId: string;
    readonly workerEpoch: number;
    readonly errorName?: string;
  },
): void {
  try {
    const ownerWindow = windows.fallbackWindow();
    const message = `Inkbook: Document Worker failure; session=${failure.sessionId}; epoch=${failure.workerEpoch}; phase=${failure.phase}; kind=${failure.kind}; request=${failure.request?.type ?? "none"}; error=${failure.errorName ?? "unknown"}.`;
    if (windows.warn !== undefined) windows.warn(ownerWindow, message);
    else
      (
        ownerWindow as (Window & { readonly console?: Pick<Console, "warn"> }) | undefined
      )?.console?.warn(message);
  } catch {
    // Console failures must not change executor recovery.
  }
}

/** Only fixed platform error names cross the console boundary. */
function workerErrorName(error: unknown): string {
  if (!(error instanceof Error || error instanceof DOMException)) return "unknown";
  switch (error.name) {
    case "AbortError":
    case "DataCloneError":
    case "Error":
    case "InvalidStateError":
    case "NotSupportedError":
    case "RangeError":
    case "SecurityError":
    case "SyntaxError":
    case "TypeError":
      return error.name;
    default:
      return "unknown";
  }
}

/** A document may move between windows while retaining its worker and dirty model. */
function createDocumentScheduler(current: () => WorkScheduler): WorkScheduler {
  const forwarding = createWindowSchedulerForwarding(current);
  let disposed = false;
  const resumeAfterTransfer = (
    error: unknown,
    original: WorkScheduler,
    signal: FrameCancellation | undefined,
    resume: (scheduler: WorkScheduler) => Promise<void> | undefined,
  ): Promise<void> | undefined => {
    if (!(error instanceof SchedulerDisposedError) || disposed || signal?.aborted) throw error;
    const replacement = current();
    if (replacement === original) throw error;
    return resume(replacement);
  };
  return {
    ...forwarding,
    checkpoint: (signal) => {
      const original = current();
      return original.checkpoint(signal)?.catch(async (error: unknown) => {
        await resumeAfterTransfer(error, original, signal, (replacement) =>
          replacement.checkpoint(signal),
        );
      });
    },
    nextFrame: (signal, priority) => {
      const original = current();
      return original.nextFrame(signal, priority).catch(async (error: unknown) => {
        await resumeAfterTransfer(error, original, signal, (replacement) =>
          replacement.nextFrame(signal, priority),
        );
      });
    },
    dispose: () => {
      disposed = true;
      forwarding.dispose();
    },
  };
}

function createFallbackWarning(windows: WorkspaceRuntimeWindowPorts): () => void {
  const warnedWindows = new WeakSet<Window>();
  let warnedWithoutWindow = false;
  return () => {
    const ownerWindow = windows.fallbackWindow();
    if (ownerWindow === undefined) {
      if (warnedWithoutWindow) return;
      warnedWithoutWindow = true;
    } else {
      if (warnedWindows.has(ownerWindow)) return;
      warnedWindows.add(ownerWindow);
    }
    if (windows.warn !== undefined) {
      windows.warn(ownerWindow, WORKER_FALLBACK_WARNING);
      return;
    }
    if (ownerWindow !== undefined) {
      const ownerConsole = (ownerWindow as Window & { readonly console?: Pick<Console, "warn"> })
        .console;
      ownerConsole?.warn(WORKER_FALLBACK_WARNING);
    }
  };
}
