import { Platform } from "obsidian";

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

interface WorkspaceRuntimeWindowPorts {
  readonly fallbackWindow: () => Window | undefined;
  readonly owningWindow: (documentId: string) => Window;
  readonly sliceBudgetMs?: (ownerWindow: Window) => number;
}

const DOCUMENT_RUNTIME_TIMEOUT_MS = 30_000;

export function createWorkspaceDocumentRuntimes(
  windows: WorkspaceRuntimeWindowPorts,
  profile = Platform.isMobile ? ("mobile" as const) : ("desktop" as const),
): DocumentRuntimeFactories {
  const sliceBudgetMs = windows.sliceBudgetMs ?? (() => (profile === "mobile" ? 12 : 8));
  return {
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
    create: async (sessionId, workerEpoch, documentId) => {
      return createDocumentRuntime(sessionId, workerEpoch, windows.owningWindow(documentId), {
        profile,
        requestTimeoutMilliseconds: DOCUMENT_RUNTIME_TIMEOUT_MS,
        sliceMilliseconds: () => sliceBudgetMs(windows.owningWindow(documentId)),
      });
    },
    createFallback: (sessionId, workerEpoch, isInputActive) => {
      const scheduler = new GestureAwareSliceScheduler({
        isInputActive,
        now: () => windows.fallbackWindow()?.performance.now() ?? performance.now(),
        profile,
        sliceMilliseconds:
          windows.sliceBudgetMs === undefined
            ? profile === "mobile"
              ? 10
              : 6
            : () => {
                const ownerWindow = windows.fallbackWindow();
                return ownerWindow === undefined
                  ? profile === "mobile"
                    ? 10
                    : 6
                  : (windows.sliceBudgetMs?.(ownerWindow) ?? 6);
              },
        yieldControl: () => yieldToWindow(windows.fallbackWindow()),
      });
      return new DocumentWorkerRuntime({ sessionId, workerEpoch }, scheduler);
    },
    createStoreScheduler: (documentId, isCancelled) => {
      let sliceStarted = windows.owningWindow(documentId).performance.now();
      return {
        isCancelled,
        shouldYield: () =>
          windows.owningWindow(documentId).performance.now() - sliceStarted >=
          sliceBudgetMs(windows.owningWindow(documentId)),
        yieldControl: () =>
          new Promise((resolve) => {
            const owningWindow = windows.owningWindow(documentId);
            owningWindow.setTimeout(() => {
              sliceStarted = windows.owningWindow(documentId).performance.now();
              resolve();
            }, 0);
          }),
      };
    },
    now: (documentId) => {
      const performance = windows.owningWindow(documentId).performance;
      return Math.floor(performance.timeOrigin + performance.now());
    },
  };
}

function yieldToWindow(ownerWindow: Window | undefined): Promise<void> {
  if (ownerWindow === undefined) return Promise.resolve();
  return new Promise((resolve) => ownerWindow.setTimeout(resolve, 0));
}
