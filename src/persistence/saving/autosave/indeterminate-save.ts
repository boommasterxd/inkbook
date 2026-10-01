import type { VaultBase, VerifiedPersistedOutput } from "../../worker/protocol";
import type { MetadataGuardedFileRead } from "../save-ports";

import { sameVaultBase } from "./verification";
import { VerifiedMetadataGuardedFileRead } from "../verified-file-read";

export type IndeterminateSaveInspection =
  | { readonly outcome: "conflict" | "retryable-error" }
  | {
      readonly confirmedBase: Extract<VaultBase, { type: "confirmed" }>;
      readonly outcome: "confirmed";
      readonly readBack?: MetadataGuardedFileRead;
    }
  | undefined;

export async function inspectIndeterminateSave(options: {
  readonly activeOutputHash: string;
  readonly activeRevision: number;
  readonly previousBase: VaultBase;
  readonly read: () => Promise<string | MetadataGuardedFileRead>;
  readonly stopped: () => boolean;
  readonly verify: (read: string | MetadataGuardedFileRead) => Promise<VerifiedPersistedOutput>;
}): Promise<IndeterminateSaveInspection> {
  let readBack: string | MetadataGuardedFileRead;
  try {
    readBack = await options.read();
  } catch {
    return undefined;
  }
  if (options.stopped()) return undefined;
  const persisted = await options.verify(readBack);
  if (options.stopped()) return undefined;
  if (typeof readBack !== "string" && readBack.isCurrent?.() === false) return undefined;
  const expected: VaultBase = {
    outputHash: options.activeOutputHash,
    revision: options.activeRevision,
    type: "confirmed",
  };
  if (sameVaultBase(persisted, expected)) {
    return {
      confirmedBase: expected,
      outcome: "confirmed",
      ...(typeof readBack === "string"
        ? {}
        : {
            readBack: VerifiedMetadataGuardedFileRead.fromVerifiedRead(readBack),
          }),
    };
  }
  if (sameVaultBase(persisted, options.previousBase)) return { outcome: "retryable-error" };
  return persisted.type === "unreadable" ? undefined : { outcome: "conflict" };
}
