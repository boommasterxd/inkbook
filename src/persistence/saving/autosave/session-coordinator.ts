import type { InkElementV1, InkSnapshotV1 } from "../../../domain/schema/public";
import type { PreparedPressurePathHint } from "../../serialization/prepared-pressure-hints";
import type { ExistingFilePort } from "../save-ports";

import { AutosaveCoordinator } from "./coordinator";
import type { AutosaveSessionBaseOptions } from "./types";

interface AutosaveSessionOptions extends AutosaveSessionBaseOptions {
  readonly orderByBand: () => Readonly<Partial<Record<"content" | "highlight", readonly string[]>>>;
  readonly path: string;
  readonly sessionId: string;
  readonly snapshot: () => InkSnapshotV1;
  readonly integritySnapshot?: () => InkSnapshotV1;
  readonly ownsIntegrityElement?: (element: InkElementV1) => boolean;
  readonly preparedPressurePaths?: (
    modelRevision: number,
    changedIds?: ReadonlySet<string>,
  ) => readonly PreparedPressurePathHint[];
  readonly vault: ExistingFilePort;
}

export function createAutosaveSession(options: AutosaveSessionOptions): AutosaveCoordinator {
  return new AutosaveCoordinator({
    workScheduler: options.workScheduler,
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
      ...(options.integritySnapshot ? { integritySnapshot: options.integritySnapshot } : {}),
      ...(options.ownsIntegrityElement
        ? { ownsIntegrityElement: options.ownsIntegrityElement }
        : {}),
      ...(options.preparedPressurePaths
        ? { preparedPressurePaths: options.preparedPressurePaths }
        : {}),
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
