import type { App } from "obsidian";

import {
  createDocumentRuntime,
  DocumentWorkerRuntime,
  type DocumentRuntimePort,
  type DocumentRuntimeResult,
} from "../../persistence/worker/runtime/public";
import { activeMarkdownOwnerWindow } from "./obsidian-host";

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

export async function validateDocumentOutput(app: App, content: string): Promise<boolean> {
  const ownerWindow = activeMarkdownOwnerWindow(app);
  const sessionId = validationSessionId(ownerWindow);
  let runtime: DocumentRuntimePort | undefined;
  let workerEpoch = 1;
  try {
    try {
      runtime = await createDocumentRuntime(sessionId, workerEpoch, ownerWindow);
      const workerResult = await executeVerification(runtime, sessionId, workerEpoch, content);
      if (workerResult.type !== "runtime-failure") return verified(workerResult);
    } catch {
      // Construction and execution failures use the same bounded algorithms below.
    } finally {
      runtime?.terminate();
      runtime = undefined;
    }

    workerEpoch += 1;
    runtime = new DocumentWorkerRuntime({ sessionId, workerEpoch });
    return verified(await executeVerification(runtime, sessionId, workerEpoch, content));
  } catch {
    return false;
  } finally {
    runtime?.terminate();
  }
}
