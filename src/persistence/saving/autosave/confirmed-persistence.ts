import type { VaultBase } from "../../worker/protocol";
import type { MetadataGuardedFileRead } from "../save-ports";

import type { AutosaveObserver } from "./types";

export function notifyConfirmedPersistence(
  observer: AutosaveObserver | undefined,
  path: string,
  base: Extract<VaultBase, { type: "confirmed" }>,
  readBack?: MetadataGuardedFileRead,
): void {
  observer?.confirmed?.({
    outputHash: base.outputHash,
    path,
    revision: base.revision,
    ...(readBack === undefined ? {} : { readBack }),
  });
}
