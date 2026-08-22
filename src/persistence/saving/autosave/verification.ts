import type {
  PurposeOperationIdentity,
  VaultBase,
  VerifiedPersistedOutput,
} from "../../worker/protocol";
import { exactStringEqual } from "../exact-string-equality";

export function sameVaultBase(left: VerifiedPersistedOutput, right: VaultBase): boolean {
  if (left.type === "unreadable") return false;
  if (left.type === "missing" || right.type === "missing") return left.type === right.type;
  return left.revision === right.revision && left.outputHash === right.outputHash;
}

export function isExactPreparedOutput(
  content: string,
  output: string,
  revision: number,
  expectedRevision: number,
  hash: string,
  expectedHash: string,
): boolean {
  return (
    revision === expectedRevision && hash === expectedHash && exactStringEqual(content, output)
  );
}

export function sameOperationIdentity(
  left: PurposeOperationIdentity,
  right: PurposeOperationIdentity,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.workerEpoch === right.workerEpoch &&
    left.purpose === right.purpose &&
    left.operationId === right.operationId
  );
}
