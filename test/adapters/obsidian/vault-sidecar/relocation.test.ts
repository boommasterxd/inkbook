import { describe, expect, it } from "vitest";

import { parseRelocationId } from "../../../../src/application/note-session";
import { VaultSidecarRelocator } from "../../../../src/adapters/obsidian/vault-sidecar/relocation";
import type { VaultFileCapability } from "../../../../src/adapters/obsidian/vault-sidecar/paths";
import { FakeVault } from "./support";

const RELOCATION_ID = parseRelocationId("rel_00000000000000000000000000");
const SOURCE_PATH = "Notes/A.inkbook.json";
const DESTINATION_PATH = "Archive/Nested/A.inkbook.json";

describe("Vault sidecar relocation", () => {
  it("creates bounded missing folders, revalidates files, and owns the event once", async () => {
    const vault = new FakeVault();
    const source = vault.addFile(SOURCE_PATH, "sidecar");
    const relocator = new VaultSidecarRelocator(vault);
    let consumed = null as ReturnType<
      VaultSidecarRelocator["consumeOwnedRenameEvent"]
    >;
    let destinationEvent: VaultFileCapability | null = null;
    vault.onRename = (oldPath, destination): void => {
      destinationEvent = destination;
      consumed = relocator.consumeOwnedRenameEvent(oldPath, destination);
    };

    const result = await relocator.relocate({
      relocationId: RELOCATION_ID,
      sourceFile: source,
      destinationPath: DESTINATION_PATH,
    });

    expect(result).toMatchObject({
      kind: "acknowledged",
      relocationId: RELOCATION_ID,
      destinationFile: { path: DESTINATION_PATH },
    });
    expect(vault.createFolderCalls).toBe(Number("2"));
    expect(vault.renameCalls).toBe(1);
    expect(consumed).toBe(RELOCATION_ID);
    expect(
      relocator.consumeOwnedRenameEvent(SOURCE_PATH, destinationEvent),
    ).toBeNull();
  });

  it("rejects destination file and folder collisions without rename", async () => {
    for (const destinationKind of ["file", "folder"] as const) {
      const vault = new FakeVault();
      const source = vault.addFile(SOURCE_PATH, "source");
      if (destinationKind === "file") {
        vault.addFile(DESTINATION_PATH, "existing");
      } else {
        vault.addFolder(DESTINATION_PATH);
      }
      const result = await new VaultSidecarRelocator(vault).relocate({
        relocationId: RELOCATION_ID,
        sourceFile: source,
        destinationPath: DESTINATION_PATH,
      });
      expect(result).toEqual({ kind: "collision" });
      expect(vault.renameCalls).toBe(0);
      expect(vault.texts.get(SOURCE_PATH)).toBe("source");
    }
  });

  it("fails closed on source, parent file, and folder confusion", async () => {
    const sourceFolderVault = new FakeVault();
    const sourceFolder = sourceFolderVault.addFolder(SOURCE_PATH);
    await expect(
      new VaultSidecarRelocator(sourceFolderVault).relocate({
        relocationId: RELOCATION_ID,
        sourceFile: sourceFolder as unknown as VaultFileCapability,
        destinationPath: DESTINATION_PATH,
      }),
    ).resolves.toEqual({ kind: "wrong-file-kind" });

    const parentFileVault = new FakeVault();
    const source = parentFileVault.addFile(SOURCE_PATH, "source");
    parentFileVault.addFile("Archive", "not a folder");
    await expect(
      new VaultSidecarRelocator(parentFileVault).relocate({
        relocationId: RELOCATION_ID,
        sourceFile: source,
        destinationPath: DESTINATION_PATH,
      }),
    ).resolves.toEqual({ kind: "wrong-file-kind" });
    expect(parentFileVault.createFolderCalls).toBe(0);
  });
});

describe("Vault sidecar relocation races and limits", () => {
  it("holds only one exact event ownership until consumed or cancelled", async () => {
    const vault = new FakeVault();
    const source = vault.addFile(SOURCE_PATH, "source");
    const relocator = new VaultSidecarRelocator(vault);
    await expect(
      relocator.relocate({
        relocationId: RELOCATION_ID,
        sourceFile: source,
        destinationPath: DESTINATION_PATH,
      }),
    ).resolves.toMatchObject({ kind: "acknowledged" });

    const otherId = parseRelocationId("rel_00000000000000000000000001");
    await expect(
      relocator.relocate({
        relocationId: otherId,
        sourceFile: source,
        destinationPath: "Other/A.inkbook.json",
      }),
    ).resolves.toEqual({ kind: "ownership-busy" });
    expect(relocator.cancelEventOwnership(otherId)).toBe(false);
    expect(relocator.cancelEventOwnership(RELOCATION_ID)).toBe(true);
    expect(
      relocator.consumeOwnedRenameEvent(
        SOURCE_PATH,
        vault.getFileByPath(DESTINATION_PATH),
      ),
    ).toBeNull();
  });

  it("detects a destination race and releases exact event ownership", async () => {
    const vault = new FakeVault();
    const source = vault.addFile(SOURCE_PATH, "source");
    vault.beforeRename = (_sourcePath, destinationPath): void => {
      vault.addFile(destinationPath, "external");
    };
    const relocator = new VaultSidecarRelocator(vault);
    await expect(
      relocator.relocate({
        relocationId: RELOCATION_ID,
        sourceFile: source,
        destinationPath: DESTINATION_PATH,
      }),
    ).resolves.toEqual({ kind: "collision" });
    expect(
      relocator.consumeOwnedRenameEvent(
        SOURCE_PATH,
        vault.getFileByPath(DESTINATION_PATH),
      ),
    ).toBeNull();
    expect(vault.texts.get(SOURCE_PATH)).toBe("source");
    expect(vault.texts.get(DESTINATION_PATH)).toBe("external");
  });

  it("rejects excessive missing folders before creating any", async () => {
    const vault = new FakeVault();
    const source = vault.addFile(SOURCE_PATH, "source");
    const segmentCount = Number("33");
    const destination = `${Array.from(
      { length: segmentCount },
      (_, index) => `d${String(index)}`,
    ).join("/")}/A.inkbook.json`;
    await expect(
      new VaultSidecarRelocator(vault).relocate({
        relocationId: RELOCATION_ID,
        sourceFile: source,
        destinationPath: destination,
      }),
    ).resolves.toEqual({ kind: "resource-limit" });
    expect(vault.createFolderCalls).toBe(0);
    expect(vault.renameCalls).toBe(0);
  });

  it("rejects invalid requests and remains cancelled after disposal", async () => {
    const vault = new FakeVault();
    const source = vault.addFile(SOURCE_PATH, "source");
    const relocator = new VaultSidecarRelocator(vault);
    await expect(
      relocator.relocate({
        relocationId: RELOCATION_ID,
        sourceFile: source,
        destinationPath: "../A.inkbook.json",
      }),
    ).resolves.toEqual({ kind: "invalid-request" });
    relocator.dispose();
    relocator.dispose();
    await expect(
      relocator.relocate({
        relocationId: RELOCATION_ID,
        sourceFile: source,
        destinationPath: DESTINATION_PATH,
      }),
    ).resolves.toEqual({ kind: "cancelled" });
    expect(vault.renameCalls).toBe(0);
  });
});
