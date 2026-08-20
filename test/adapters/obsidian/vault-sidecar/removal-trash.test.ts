import { TFile, TFolder, type FileManager, type Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { ObsidianSidecarTrashPortV1 } from "../../../../src/adapters/obsidian/vault-sidecar/removal-trash";
import type { RemovalRecordV1 } from "../../../../src/application/recovery";

const RECORD = {
  sidecarBase: { vaultRelativePath: "Notes/A.inkbook.json" },
} as RemovalRecordV1;

describe("Obsidian sidecar trash port", () => {
  it("uses FileManager.trashFile for one exact concrete TFile", async () => {
    const file = hostFile("Notes/A.inkbook.json");
    const trashFile = vi.fn(async () => undefined);
    const port = new ObsidianSidecarTrashPortV1(
      { getFileByPath: vi.fn(() => file) } as unknown as Vault,
      { trashFile } as unknown as FileManager,
    );

    await port.trashSidecar(RECORD);

    expect(trashFile).toHaveBeenCalledOnce();
    expect(trashFile).toHaveBeenCalledWith(file);
  });

  it("rejects missing, folder, and unsafe targets without deleting", async () => {
    const trashFile = vi.fn(async () => undefined);
    const folder = hostFolder("Notes/A.inkbook.json");
    const port = new ObsidianSidecarTrashPortV1(
      { getFileByPath: vi.fn(() => folder) } as unknown as Vault,
      { trashFile } as unknown as FileManager,
    );

    await expect(port.trashSidecar(RECORD)).rejects.toThrow();
    await expect(
      port.trashSidecar({
        ...RECORD,
        sidecarBase: {
          ...RECORD.sidecarBase,
          vaultRelativePath: "../A.inkbook.json",
        },
      }),
    ).rejects.toThrow();
    expect(trashFile).not.toHaveBeenCalled();
  });
});

function hostFile(path: string): TFile {
  const file = Object.create(TFile.prototype) as TFile;
  Object.defineProperty(file, "path", { value: path });
  return file;
}

function hostFolder(path: string): TFolder {
  const folder = Object.create(TFolder.prototype) as TFolder;
  Object.defineProperty(folder, "path", { value: path });
  return folder;
}
