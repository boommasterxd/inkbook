import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type {
  PurposeOperationIdentity,
  VaultBase,
  VerifiedPersistedOutput,
} from "../../worker/protocol";
import type { DocumentRuntimePort, DocumentRuntimeResult } from "../../worker/runtime/public";
import {
  hashConfirmedSvgContent,
  inspectTrustedSvgOutput,
} from "../../scheduling/trusted-svg-output";

import { scanCanonicalRevisionPrefix } from "../revision-scan";

import { sameOperationIdentity } from "./verification";

export async function verifyExactWorkerContent(
  executor: DocumentRuntimePort,
  identity: PurposeOperationIdentity,
  content: string,
  versionPolicy: "current" | "editable" = "current",
  options: {
    readonly workScheduler?: WorkScheduler;
    readonly waitForBackground?: () => Promise<void>;
    readonly confirmedBase?: VaultBase;
  } = {},
): Promise<VerifiedPersistedOutput> {
  let trusted;
  try {
    const base = options.confirmedBase;
    if (
      identity.purpose === "preflight" &&
      versionPolicy === "editable" &&
      base?.type === "confirmed" &&
      scanCanonicalRevisionPrefix(content) === base.revision &&
      (await hashConfirmedSvgContent(content, options)) === base.outputHash
    ) {
      return { outputHash: base.outputHash, revision: base.revision, type: "confirmed" };
    }
    trusted = await inspectTrustedSvgOutput(content, undefined, {
      ...(options.workScheduler ? { workScheduler: options.workScheduler } : {}),
      versionPolicy,
      ...(options.waitForBackground ? { waitForBackground: options.waitForBackground } : {}),
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
