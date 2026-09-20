import type { PurposeOperationIdentity, VerifiedPersistedOutput } from "../../worker/protocol";
import type { DocumentRuntimePort, DocumentRuntimeResult } from "../../worker/runtime/public";
import { inspectTrustedSvgOutput } from "../../scheduling/trusted-svg-output";

import { sameOperationIdentity } from "./verification";

export async function verifyExactWorkerContent(
  executor: DocumentRuntimePort,
  identity: PurposeOperationIdentity,
  content: string,
  versionPolicy: "current" | "editable" = "current",
  waitForBackground?: () => Promise<void>,
): Promise<VerifiedPersistedOutput> {
  let trusted;
  try {
    trusted = await inspectTrustedSvgOutput(content, undefined, {
      versionPolicy,
      ...(waitForBackground ? { waitForBackground } : {}),
    });
  } catch {
    return { type: "unreadable" };
  }
  const result = await executor.execute({ identity, input: content, type: "verify-output" });
  return verifiedResult(identity, result, trusted);
}

function verifiedResult(
  identity: PurposeOperationIdentity,
  result: DocumentRuntimeResult,
  trusted: { readonly outputHash: string; readonly revision: number },
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
    result.persisted.revision !== trusted.revision ||
    result.persisted.outputHash !== trusted.outputHash
  ) {
    throw new Error("Persisted output verification does not match the exact content.");
  }
  return { ...trusted, type: "confirmed" };
}
