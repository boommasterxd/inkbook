import type { App } from "obsidian";
import { FRAME_WORK_SHARE, type WorkScheduler } from "../../domain/scheduling/work-scheduler";

import {
  createDocumentRuntime,
  DocumentWorkerRuntime,
  GestureAwareSliceScheduler,
  type DocumentRuntimePort,
  type DocumentRuntimeResult,
} from "../../persistence/worker/runtime/public";
import { activeMarkdownOwnerWindow } from "./obsidian-host";

export interface DocumentOutputScheduling {
  readonly workScheduler: (ownerWindow: Window | null) => WorkScheduler;
  readonly subscribeSchedulingProfile: (listener: () => void) => () => void;
}

function validationSessionId(ownerWindow: Window): string {
  const bytes = new Uint8Array(12);
  ownerWindow.crypto.getRandomValues(bytes);
  return `document-output-validation-${[...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function verified(result: DocumentRuntimeResult): boolean {
  return result.type === "verify-output-success" && result.persisted.type === "confirmed";
}

async function executeVerification(
  runtime: DocumentRuntimePort,
  sessionId: string,
  workerEpoch: number,
  content: string,
): Promise<DocumentRuntimeResult> {
  return runtime.execute({
    identity: { operationId: 1, purpose: "verification", sessionId, workerEpoch },
    input: content,
    type: "verify-output",
  });
}

export async function validateDocumentOutput(
  app: App,
  content: string,
  scheduling: DocumentOutputScheduling,
): Promise<boolean> {
  const ownerWindow = activeMarkdownOwnerWindow(app);
  const workScheduler = scheduling.workScheduler(ownerWindow);
  const sessionId = validationSessionId(ownerWindow);
  let runtime: DocumentRuntimePort | undefined;
  let workerEpoch = 1;
  try {
    try {
      runtime = await createDocumentRuntime(sessionId, workerEpoch, ownerWindow, {
        workScheduler,
        frameIntervalMilliseconds: () => workScheduler.budgetMs() / FRAME_WORK_SHARE,
        subscribeSchedulingProfile: scheduling.subscribeSchedulingProfile,
      });
      const workerResult = await executeVerification(runtime, sessionId, workerEpoch, content);
      if (workerResult.type !== "runtime-failure") return verified(workerResult);
    } catch {
      // Construction and execution failures use the same bounded algorithms below.
    } finally {
      runtime?.terminate();
      runtime = undefined;
    }

    workerEpoch += 1;
    runtime = new DocumentWorkerRuntime(
      { sessionId, workerEpoch },
      new GestureAwareSliceScheduler({ isInputActive: () => false, workScheduler }),
    );
    return verified(await executeVerification(runtime, sessionId, workerEpoch, content));
  } catch {
    return false;
  } finally {
    runtime?.terminate();
  }
}
