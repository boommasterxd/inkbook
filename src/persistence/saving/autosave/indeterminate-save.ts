import type { VaultBase, VerifiedPersistedOutput } from "../../worker/protocol";

import { sameVaultBase } from "./verification";

export type IndeterminateSaveInspection =
  | { readonly outcome: "conflict" | "retryable-error" }
  | {
      readonly confirmedBase: Extract<VaultBase, { type: "confirmed" }>;
      readonly outcome: "confirmed";
    }
  | undefined;

export async function inspectIndeterminateSave(options: {
  readonly activeOutputHash: string;
  readonly activeRevision: number;
  readonly previousBase: VaultBase;
  readonly read: () => Promise<string>;
  readonly stopped: () => boolean;
  readonly verify: (content: string) => Promise<VerifiedPersistedOutput>;
}): Promise<IndeterminateSaveInspection> {
  let content: string;
  try {
    content = await options.read();
  } catch {
    return undefined;
  }
  if (options.stopped()) return undefined;
  const persisted = await options.verify(content);
  if (options.stopped()) return undefined;
  const expected: VaultBase = {
    outputHash: options.activeOutputHash,
    revision: options.activeRevision,
    type: "confirmed",
  };
  if (sameVaultBase(persisted, expected)) {
    return { confirmedBase: expected, outcome: "confirmed" };
  }
  if (sameVaultBase(persisted, options.previousBase)) return { outcome: "retryable-error" };
  return persisted.type === "unreadable" ? undefined : { outcome: "conflict" };
}
