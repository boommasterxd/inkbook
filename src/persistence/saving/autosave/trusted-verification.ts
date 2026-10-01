import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type {
  PurposeOperationIdentity,
  VaultBase,
  VerifiedPersistedOutput,
} from "../../worker/protocol";
import type { DocumentRuntimePort, DocumentRuntimeResult } from "../../worker/runtime/public";

import { scanCanonicalRevisionPrefix } from "../revision-scan";

import { sameOperationIdentity } from "./verification";

export async function verifyExactWorkerContent(
  executor: DocumentRuntimePort,
  identity: PurposeOperationIdentity,
  content: string,
  versionPolicy: "current" | "editable" = "current",
  options: {
    readonly workScheduler?: WorkScheduler;
    readonly waitForBackground?: () => Promise<void> | undefined;
    readonly confirmedBase?: VaultBase;
    readonly expectedBytes?: number;
    readonly assertCurrent?: () => void;
  } = {},
): Promise<VerifiedPersistedOutput> {
  const pending = options.waitForBackground?.();
  if (pending !== undefined) await pending;
  options.assertCurrent?.();
  const base = options.confirmedBase;
  const result = await executor.execute({
    identity,
    input: content,
    type: "verify-output",
    versionPolicy,
    ...(options.expectedBytes === undefined ? {} : { expectedBytes: options.expectedBytes }),
    ...(identity.purpose === "preflight" &&
    versionPolicy === "editable" &&
    base?.type === "confirmed"
      ? { confirmedBase: base }
      : {}),
  });
  options.assertCurrent?.();
  return verifiedResult(identity, result, content);
}

function verifiedResult(
  identity: PurposeOperationIdentity,
  result: DocumentRuntimeResult,
  content: string,
): VerifiedPersistedOutput {
  if (
    result.type !== "verify-output-success" ||
    !sameOperationIdentity(identity, result.identity)
  ) {
    throw new Error("Persisted output verification failed.");
  }
  if (result.persisted.type === "unreadable") return result.persisted;
  if (
    result.persisted.type !== "confirmed" ||
    result.persisted.revision !== scanCanonicalRevisionPrefix(content) ||
    !/^[0-9a-f]{64}$/u.test(result.persisted.outputHash)
  ) {
    throw new Error("Persisted output verification does not match the exact content.");
  }
  return result.persisted;
}
