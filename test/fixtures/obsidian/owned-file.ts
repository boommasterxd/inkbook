import { TFile } from "obsidian";

import type { MetadataGuardedFileRead } from "../../../src/persistence/saving/save-ports";
import type { TrackedCreatedVaultFile } from "../../../src/obsidian/vault/file-adapter";

const TestTFile = TFile as unknown as new (path: string, size?: number) => TFile;

export function ownedFileRead(
  path: string,
  readBack: MetadataGuardedFileRead,
  onCreated: (created: TrackedCreatedVaultFile) => void,
) {
  const created = {
    file: new TestTFile(path, readBack.content.length),
    isCurrent: () => true,
    release: () => undefined,
  };
  onCreated(created);
  return { ...created, readBack };
}
