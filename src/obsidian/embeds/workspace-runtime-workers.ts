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
  readonly warn?: (ownerWindow: Window | undefined, message: string) => void;
}

const DOCUMENT_RUNTIME_TIMEOUT_MS = 30_000;
const WORKER_FALLBACK_WARNING =
  "Inkbook: Document Worker unavailable or failed; using the bounded main-thread fallback. Performance may be reduced.";

export function createWorkspaceDocumentRuntimes(
  windows: WorkspaceRuntimeWindowPorts,
  profile = Platform.isMobile ? ("mobile" as const) : ("desktop" as const),
): DocumentRuntimeFactories {
  const sliceBudgetMs = windows.sliceBudgetMs ?? (() => (profile === "mobile" ? 12 : 8));
  const warnFallback = createFallbackWarning(windows);
  return {
    sliceBudgetMs: (documentId) => windows.sliceBudgetMs?.(windows.owningWindow(documentId)) ?? 4,
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
      warnFallback();
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
        yieldControl: async () => {
          await yieldToWindow(windows.owningWindow(documentId));
          sliceStarted = windows.owningWindow(documentId).performance.now();
        },
      };
    },
    now: (documentId) => {
      const performance = windows.owningWindow(documentId).performance;
      return Math.floor(performance.timeOrigin + performance.now());
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

function yieldToWindow(ownerWindow: Window | undefined): Promise<void> {
  if (ownerWindow === undefined) return Promise.resolve();
  const channelConstructor = (ownerWindow as Window & { MessageChannel?: typeof MessageChannel })
    .MessageChannel;
  if (channelConstructor === undefined)
    return new Promise((resolve) => ownerWindow.setTimeout(resolve, 0));
  return new Promise((resolve, reject) => {
    const channel = new channelConstructor();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    try {
      channel.port2.postMessage(undefined);
    } catch (error) {
      channel.port1.close();
      channel.port2.close();
      reject(error instanceof Error ? error : new Error("Store handoff failed."));
    }
  });
}
