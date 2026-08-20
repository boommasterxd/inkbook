import { normalizePath, TFile, type FileManager, type Vault } from "obsidian";

import type { RemovalRecordV1 } from "../../../application/recovery";
import { validateSidecarPathV1 } from "../../../application/persistence";

/** Implements only the recoverable host trash step of annotation removal. */
export class ObsidianSidecarTrashPortV1 {
  public constructor(
    private readonly vault: Vault,
    private readonly fileManager: FileManager,
  ) {}

  public async trashSidecar(record: RemovalRecordV1): Promise<void> {
    const path = validateSidecarPathV1(record.sidecarBase.vaultRelativePath, {
      normalizePath,
    });
    const file = this.vault.getFileByPath(path);
    if (!(file instanceof TFile) || file.path !== path) {
      throw new TypeError("The sidecar trash target is not a concrete TFile.");
    }
    await this.fileManager.trashFile(file);
  }
}
