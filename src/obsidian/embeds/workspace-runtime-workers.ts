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
    create: (sessionId, workerEpoch, documentId) => {
      const scheduler = workScheduler(documentId);
      return createDocumentRuntime(sessionId, workerEpoch, windows.owningWindow(documentId), {
        workScheduler: scheduler,
        frameIntervalMilliseconds: () => scheduler.budgetMs() / FRAME_WORK_SHARE,
        requestTimeoutMilliseconds: DOCUMENT_RUNTIME_TIMEOUT_MS,
        subscribeSchedulingProfile: windows.subscribeSchedulingProfile,
      });
    },
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
