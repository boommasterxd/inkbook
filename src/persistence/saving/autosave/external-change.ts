import type { VaultBase, VerifiedPersistedOutput } from "../../worker/protocol";

import { sameVaultBase } from "./verification";
import type { MetadataGuardedFileRead } from "../save-ports";

export type ExternalChangeInspection =
  | { readonly outcome: "conflict" | "unchanged" }
  | {
      readonly confirmedBase: Extract<VaultBase, { type: "confirmed" }>;
      readonly outcome: "reload-required";
    };

export async function inspectAutosaveExternalChange(options: {
  readonly activeSaveBase: () => VaultBase | undefined;
  readonly confirmedBase: VaultBase;
  readonly currentRevision: () => number;
  readonly dirty: () => boolean;
  readonly read: () => Promise<string | MetadataGuardedFileRead>;
  readonly stopped: () => boolean;
  readonly verify: (read: string | MetadataGuardedFileRead) => Promise<VerifiedPersistedOutput>;
}): Promise<ExternalChangeInspection> {
  const expectedRevision = options.currentRevision();
  const content = await runUnlessStopped(options.read, options.stopped);
  if (content === undefined) return { outcome: "conflict" };
  const persisted = await runUnlessStopped(() => options.verify(content), options.stopped);
  if (persisted === undefined) return { outcome: "conflict" };
  if (typeof content !== "string" && content.isCurrent?.() === false)
    return { outcome: "conflict" };
  const activeSaveBase = options.activeSaveBase();
  if (
    sameVaultBase(persisted, options.confirmedBase) ||
    (activeSaveBase !== undefined && sameVaultBase(persisted, activeSaveBase))
  ) {
    return { outcome: "unchanged" };
  }
  if (
    persisted.type !== "confirmed" ||
    options.currentRevision() !== expectedRevision ||
    options.dirty()
  ) {
    return { outcome: "conflict" };
  }
  return { confirmedBase: persisted, outcome: "reload-required" };
}

async function runUnlessStopped<Value>(
  operation: () => Promise<Value>,
  stopped: () => boolean,
): Promise<Value | undefined> {
  try {
    const value = await operation();
    return stopped() ? undefined : value;
  } catch (error) {
    if (stopped()) return undefined;
    throw error;
  }
}
