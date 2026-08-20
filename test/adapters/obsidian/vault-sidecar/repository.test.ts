import { describe, expect, it } from "vitest";

import {
  isPreparedSidecarWriteValid,
  SIDECAR_READ_LIMIT_BYTES,
  VaultSidecarRepository,
} from "../../../../src/adapters/obsidian/vault-sidecar/repository";
import { completeSidecar } from "../../../application/persistence/support";
import { FakeVault, preparedSidecarWrite } from "./support";

const SIDECAR_PATH = "Notes/A.inkbook.json";
const EXPECTED_CREATED_FOLDERS = 2;

describe("Vault sidecar repository loading", () => {
  it("retains exact raw text and measured bytes without parsing", async () => {
    const vault = new FakeVault();
    const prepared = preparedSidecarWrite(completeSidecar(), "desktop-tablet");
    vault.addFile(SIDECAR_PATH, prepared.rawText);
    const repository = new VaultSidecarRepository(vault);
    await expect(repository.readRaw(SIDECAR_PATH)).resolves.toMatchObject({
      admittedUtf8Bytes: prepared.utf8Bytes,
      kind: "raw",
      rawText: prepared.rawText,
    });
  });

  it("checks stat before read and rejects folder or mismatched file capabilities", async () => {
    const vault = new FakeVault();
    vault.addFile(SIDECAR_PATH, "{}", SIDECAR_READ_LIMIT_BYTES + 1);
    const repository = new VaultSidecarRepository(vault);
    await expect(repository.readRaw(SIDECAR_PATH)).resolves.toEqual({
      kind: "resource-limited",
    });
    expect(vault.cachedReadCalls).toBe(0);

    vault.entries.set(SIDECAR_PATH, vault.addFolder("Notes/Folder"));
    await expect(repository.readRaw(SIDECAR_PATH)).resolves.toEqual({
      kind: "wrong-file-kind",
    });
    expect(vault.cachedReadCalls).toBe(0);
  });

  it("converts a cachedRead rejection into a closed invalid result", async () => {
    const vault = new FakeVault();
    const failure = new Error("Vault read failed.");
    vault.addFile(SIDECAR_PATH, "{}\n");
    vault.cachedReadFailure = failure;
    await expect(
      new VaultSidecarRepository(vault).readRaw(SIDECAR_PATH),
    ).resolves.toEqual({ kind: "invalid", error: failure });
  });
});

describe("Vault sidecar repository writes", () => {
  it("creates validated missing parent folders before the sidecar", async () => {
    const vault = new FakeVault();
    const prepared = preparedSidecarWrite(completeSidecar(), "desktop-tablet");

    await expect(
      new VaultSidecarRepository(vault).createIfAbsent(
        "Annotations/Notes/A.inkbook.json",
        prepared,
      ),
    ).resolves.toMatchObject({ kind: "acknowledged" });
    expect(vault.createFolderCalls).toBe(EXPECTED_CREATED_FOLDERS);
    expect(vault.entries.get("Annotations")).toMatchObject({
      path: "Annotations",
    });
    expect(vault.entries.get("Annotations/Notes")).toMatchObject({
      path: "Annotations/Notes",
    });
  });

  it("fails closed when a parent path resolves to a file", async () => {
    const vault = new FakeVault();
    vault.addFile("Annotations", "not a folder");
    const prepared = preparedSidecarWrite(completeSidecar(), "desktop-tablet");

    await expect(
      new VaultSidecarRepository(vault).createIfAbsent(
        "Annotations/Notes/A.inkbook.json",
        prepared,
      ),
    ).resolves.toEqual({ kind: "wrong-file-kind" });
    expect(vault.createCalls).toBe(0);
  });

  it("creates only on explicit commit and fails a create race without overwrite", async () => {
    const vault = new FakeVault();
    const prepared = preparedSidecarWrite(completeSidecar(), "desktop-tablet");
    const repository = new VaultSidecarRepository(vault);
    expect(vault.createCalls).toBe(0);
    await expect(
      repository.createIfAbsent(SIDECAR_PATH, prepared),
    ).resolves.toEqual({ kind: "acknowledged", rawText: prepared.rawText });
    expect(vault.texts.get(SIDECAR_PATH)).toBe(prepared.rawText);

    const racingVault = new FakeVault();
    racingVault.beforeCreate = (path): void => {
      racingVault.addFile(path, "external");
    };
    await expect(
      new VaultSidecarRepository(racingVault).createIfAbsent(
        SIDECAR_PATH,
        prepared,
      ),
    ).resolves.toEqual({ kind: "collision" });
    expect(racingVault.texts.get(SIDECAR_PATH)).toBe("external");
  });

  it("rejects a forged prepared byte count before Vault I/O", async () => {
    const vault = new FakeVault();
    const repository = new VaultSidecarRepository(vault);
    const result = await repository.createIfAbsent(SIDECAR_PATH, {
      rawText: "{}\n",
      utf8Bytes: 1,
    });
    expect(result.kind).toBe("failed");
    expect(vault.createCalls).toBe(0);

    const file = vault.addFile(SIDECAR_PATH, "base");
    const processResult = await repository.compareAndProcess(file, "base", {
      rawText: "{}\n",
      utf8Bytes: 1,
    });
    expect(processResult.kind).toBe("failed");
    expect(vault.processCalls).toBe(0);
  });
});

describe("prepared Vault sidecar bytes", () => {
  it("admits the exact 16 MiB prepared boundary and rejects above it", () => {
    const atLimit = "a".repeat(SIDECAR_READ_LIMIT_BYTES);
    expect(
      isPreparedSidecarWriteValid({
        rawText: atLimit,
        utf8Bytes: SIDECAR_READ_LIMIT_BYTES,
      }),
    ).toBe(true);
    expect(
      isPreparedSidecarWriteValid({
        rawText: `${atLimit}a`,
        utf8Bytes: SIDECAR_READ_LIMIT_BYTES + 1,
      }),
    ).toBe(false);
  });
});

describe("Vault sidecar compare-and-process", () => {
  it("compares and returns inside the synchronous process callback", async () => {
    const vault = new FakeVault();
    const base = preparedSidecarWrite(completeSidecar(), "desktop-tablet");
    const replacement = {
      rawText: `${base.rawText} `,
      utf8Bytes: base.utf8Bytes + 1,
    };
    const file = vault.addFile(SIDECAR_PATH, base.rawText);
    const repository = new VaultSidecarRepository(vault);
    await expect(
      repository.compareAndProcess(file, base.rawText, replacement),
    ).resolves.toEqual({
      kind: "acknowledged",
      rawText: replacement.rawText,
    });
    expect(vault.processCallbackWasSynchronous).toBe(true);
    expect(vault.texts.get(SIDECAR_PATH)).toBe(replacement.rawText);
  });

  it("detects a final compare race and preserves external bytes", async () => {
    const vault = new FakeVault();
    const base = preparedSidecarWrite(completeSidecar(), "desktop-tablet");
    const file = vault.addFile(SIDECAR_PATH, base.rawText);
    vault.beforeProcess = (path): void => {
      vault.texts.set(path, "external raw text");
    };
    await expect(
      new VaultSidecarRepository(vault).compareAndProcess(
        file,
        base.rawText,
        base,
      ),
    ).resolves.toEqual({ kind: "conflict" });
    expect(vault.texts.get(SIDECAR_PATH)).toBe("external raw text");
  });

  it("reports stale acknowledgement after disposal without a second write", async () => {
    const vault = new FakeVault();
    const prepared = preparedSidecarWrite(completeSidecar(), "desktop-tablet");
    let release = (): void => undefined;
    vault.createBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const repository = new VaultSidecarRepository(vault);
    const pending = repository.createIfAbsent(SIDECAR_PATH, prepared);
    await Promise.resolve();
    repository.dispose();
    release();
    await expect(pending).resolves.toEqual({ kind: "stale-acknowledgement" });
    expect(vault.createCalls).toBe(1);
  });
});
