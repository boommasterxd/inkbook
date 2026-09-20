import type { InkSnapshotV1 } from "../../../domain/schema/public";
import type { ExistingFilePort } from "../save-ports";

import { AutosaveCoordinator } from "./coordinator";
import type { AutosaveSessionBaseOptions } from "./types";

interface AutosaveSessionOptions extends AutosaveSessionBaseOptions {
  readonly orderByBand: () => Readonly<Partial<Record<"content" | "highlight", readonly string[]>>>;
  readonly path: string;
  readonly sessionId: string;
  readonly snapshot: () => InkSnapshotV1;
  readonly vault: ExistingFilePort;
}

export function createAutosaveSession(options: AutosaveSessionOptions): AutosaveCoordinator {
  return new AutosaveCoordinator({
    ...(options.beforeExistingWrite === undefined
      ? {}
      : { beforeExistingWrite: options.beforeExistingWrite }),
    ...(options.waitForBackground ? { waitForBackground: options.waitForBackground } : {}),
    clock: options.clock,
    confirmedBase: {
      outputHash: options.outputHash,
      revision: options.initialSnapshot.revision,
      type: "confirmed",
    },
    ...(options.createFallback === undefined ? {} : { createFallback: options.createFallback }),
    documentSource: {
      currentRevision: options.currentRevision,
      isGestureActive: options.isGestureActive,
      orderByBand: options.orderByBand,
      snapshot: options.snapshot,
    },
    executor: options.executor,
    initialSnapshot: options.initialSnapshot,
    observer: { confirmed: options.confirmed, statusChanged: () => undefined },
    path: options.path,
    ...(options.requiresCanonicalRewrite === undefined
      ? {}
      : { requiresCanonicalRewrite: options.requiresCanonicalRewrite }),
    sessionId: options.sessionId,
    vault: options.vault,
    workerEpoch: options.workerEpoch,
  });
}

export function prepareAutosaveForUnload(
  autosave: AutosaveCoordinator | undefined,
  dispose: () => void,
): Promise<void> {
  if (autosave === undefined || !autosave.dirty) {
    dispose();
    return Promise.resolve();
  }
  return autosave.flush("detach").then(
    () => {
      dispose();
    },
    (error: unknown) => {
      dispose();
      throw error;
    },
  );
}
