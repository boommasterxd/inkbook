import { describe, expect, it } from "vitest";

import {
  isPreparedSidecarWriteValid,
  SIDECAR_READ_LIMIT_BYTES,
  VaultSidecarRepository,
} from "../../../../src/adapters/obsidian/vault-sidecar/repository";
import type { VaultFileCapability } from "../../../../src/adapters/obsidian/vault-sidecar/paths";
import { completeSidecar } from "../../../application/persistence/support";
import {
  FakeVault,
  fakeFile,
  fakeFolder,
  preparedSidecarWrite,
} from "./support";

const PATH = "Notes/A.inkbook.json";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined)
    throw new Error("Deferred was not initialized.");
  return { promise, resolve: resolvePromise };
}

class DeferredVault extends FakeVault {
  readonly readGate = deferred<true>();
  readonly processGate = deferred<true>();
  delayRead = false;
  delayProcess = false;
  unexpectedProcessAcknowledgement = false;

  public override async cachedRead(file: VaultFileCapability): Promise<string> {
    if (this.delayRead) await this.readGate.promise;
    return super.cachedRead(file);
  }

  public override async process(
    file: VaultFileCapability,
    callback: (currentText: string) => string,
  ): Promise<string> {
    const result = await super.process(file, callback);
    if (this.delayProcess) await this.processGate.promise;
    return this.unexpectedProcessAcknowledgement
      ? `${result}unexpected`
      : result;
  }
}

class FolderFaultVault extends FakeVault {
  abortAfterCreate: (() => void) | undefined;
  raceFolder = false;
  rejectFolder = false;

  public override async createFolder(path: string): Promise<void> {
    this.createFolderCalls += 1;
    if (this.raceFolder) {
      this.addFolder(path);
      throw new Error("Concurrent folder creation.");
    }
    if (this.rejectFolder) throw new Error("Folder creation failed.");
    this.addFolder(path);
    this.abortAfterCreate?.();
  }
}

describe("Vault sidecar repository branch behavior", () => {
  it("counts ASCII and every multibyte UTF-8 width exactly", () => {
    const rawText = "aé€😀";
    expect(isPreparedSidecarWriteValid({ rawText, utf8Bytes: 10 })).toBe(true);
    expect(isPreparedSidecarWriteValid({ rawText, utf8Bytes: 9 })).toBe(false);
  });

  it("returns absent, raw, oversized-after-read, and cancelled read outcomes", async () => {
    const absent = new FakeVault();
    await expect(
      new VaultSidecarRepository(absent).readRaw(PATH),
    ).resolves.toEqual({ kind: "absent" });

    const unparsed = new FakeVault();
    unparsed.addFile(PATH, "not-json");
    await expect(
      new VaultSidecarRepository(unparsed).readRaw(PATH),
    ).resolves.toMatchObject({ kind: "raw", rawText: "not-json" });

    const oversized = new FakeVault();
    oversized.addFile(PATH, "a".repeat(SIDECAR_READ_LIMIT_BYTES + 1), 1);
    await expect(
      new VaultSidecarRepository(oversized).readRaw(PATH),
    ).resolves.toEqual({ kind: "resource-limited" });

    const pendingVault = new DeferredVault();
    pendingVault.delayRead = true;
    pendingVault.addFile(
      PATH,
      preparedSidecarWrite(completeSidecar(), "phone").rawText,
    );
    const repository = new VaultSidecarRepository(pendingVault);
    const pending = repository.readRaw(PATH);
    repository.dispose();
    repository.dispose();
    pendingVault.readGate.resolve(true);
    await expect(pending).resolves.toEqual({ kind: "cancelled" });
    await expect(repository.readRaw(PATH)).resolves.toEqual({
      kind: "cancelled",
    });
  });

  it("rejects invalid descriptors and mismatched file-folder capabilities before reads", async () => {
    const vault = new FakeVault();
    vault.entries.set(PATH, {
      path: PATH,
      stat: { size: -1 },
    });
    await expect(
      new VaultSidecarRepository(vault).readRaw(PATH),
    ).resolves.toEqual({ kind: "wrong-file-kind" });
    vault.entries.set(PATH, fakeFile("Notes/Other.inkbook.json"));
    await expect(
      new VaultSidecarRepository(vault).readRaw(PATH),
    ).resolves.toEqual({ kind: "wrong-file-kind" });
    vault.entries.set(PATH, fakeFolder(PATH));
    await expect(
      new VaultSidecarRepository(vault).readRaw(PATH),
    ).resolves.toEqual({ kind: "wrong-file-kind" });
    expect(vault.cachedReadCalls).toBe(0);
  });
});

describe("Vault sidecar repository folder branches", () => {
  it("handles root creation, existing folders, and pre-aborted creation", async () => {
    const prepared = preparedSidecarWrite(completeSidecar(), "phone");
    const root = new FakeVault();
    await expect(
      new VaultSidecarRepository(root).createIfAbsent(
        "A.inkbook.json",
        prepared,
      ),
    ).resolves.toMatchObject({ kind: "acknowledged" });
    expect(root.createFolderCalls).toBe(0);

    const existing = new FakeVault();
    existing.addFolder("Notes");
    await expect(
      new VaultSidecarRepository(existing).createIfAbsent(PATH, prepared),
    ).resolves.toMatchObject({ kind: "acknowledged" });
    expect(existing.createFolderCalls).toBe(0);

    const abort = new AbortController();
    abort.abort();
    await expect(
      new VaultSidecarRepository(new FakeVault()).createIfAbsent(
        PATH,
        prepared,
        abort.signal,
      ),
    ).resolves.toEqual({ kind: "cancelled" });
  });

  it("distinguishes a raced folder from a failed folder creation", async () => {
    const prepared = preparedSidecarWrite(completeSidecar(), "phone");
    const raced = new FolderFaultVault();
    raced.raceFolder = true;
    await expect(
      new VaultSidecarRepository(raced).createIfAbsent(PATH, prepared),
    ).resolves.toMatchObject({ kind: "acknowledged" });

    const failed = new FolderFaultVault();
    failed.rejectFolder = true;
    await expect(
      new VaultSidecarRepository(failed).createIfAbsent(PATH, prepared),
    ).resolves.toMatchObject({ kind: "failed" });
  });

  it("cancels before the next folder and reports stale acknowledgement after the last folder", async () => {
    const prepared = preparedSidecarWrite(completeSidecar(), "phone");
    const abort = new AbortController();
    const between = new FolderFaultVault();
    between.abortAfterCreate = (): void => abort.abort();
    await expect(
      new VaultSidecarRepository(between).createIfAbsent(
        "A/B/C.inkbook.json",
        prepared,
        abort.signal,
      ),
    ).resolves.toEqual({ kind: "cancelled" });

    const finalAbort = new AbortController();
    const final = new FolderFaultVault();
    final.abortAfterCreate = (): void => finalAbort.abort();
    await expect(
      new VaultSidecarRepository(final).createIfAbsent(
        PATH,
        prepared,
        finalAbort.signal,
      ),
    ).resolves.toEqual({ kind: "stale-acknowledgement" });
  });

  it("returns failed when create throws without a collision", async () => {
    const vault = new FakeVault();
    vault.beforeCreate = (): void => {
      throw new Error("Injected create failure.");
    };
    await expect(
      new VaultSidecarRepository(vault).createIfAbsent(
        PATH,
        preparedSidecarWrite(completeSidecar(), "phone"),
      ),
    ).resolves.toMatchObject({ kind: "failed" });
  });
});

describe("Vault sidecar repository process branches", () => {
  it("covers disposed, aborted, stale, wrong-kind, failed, and unexpected process acknowledgements", async () => {
    const prepared = preparedSidecarWrite(completeSidecar(), "phone");
    const vault = new DeferredVault();
    const file = vault.addFile(PATH, prepared.rawText);
    const disposed = new VaultSidecarRepository(vault);
    disposed.dispose();
    await expect(
      disposed.compareAndProcess(file, prepared.rawText, prepared),
    ).resolves.toEqual({ kind: "cancelled" });

    const abort = new AbortController();
    abort.abort();
    await expect(
      new VaultSidecarRepository(vault).compareAndProcess(
        file,
        prepared.rawText,
        prepared,
        abort.signal,
      ),
    ).resolves.toEqual({ kind: "cancelled" });

    vault.entries.set(PATH, fakeFolder(PATH));
    await expect(
      new VaultSidecarRepository(vault).compareAndProcess(
        file,
        prepared.rawText,
        prepared,
      ),
    ).resolves.toEqual({ kind: "wrong-file-kind" });
    vault.entries.set(PATH, file);
    vault.texts.delete(PATH);
    await expect(
      new VaultSidecarRepository(vault).compareAndProcess(
        file,
        prepared.rawText,
        prepared,
      ),
    ).resolves.toMatchObject({ kind: "failed" });

    vault.texts.set(PATH, prepared.rawText);
    vault.unexpectedProcessAcknowledgement = true;
    await expect(
      new VaultSidecarRepository(vault).compareAndProcess(
        file,
        prepared.rawText,
        prepared,
      ),
    ).resolves.toMatchObject({ kind: "failed" });

    vault.unexpectedProcessAcknowledgement = false;
    vault.delayProcess = true;
    const repository = new VaultSidecarRepository(vault);
    const pending = repository.compareAndProcess(
      file,
      prepared.rawText,
      prepared,
    );
    await Promise.resolve();
    repository.dispose();
    vault.processGate.resolve(true);
    await expect(pending).resolves.toEqual({ kind: "stale-acknowledgement" });
  });

  it("rejects invalid normalized paths without any Vault write", async () => {
    const vault = new FakeVault();
    const repository = new VaultSidecarRepository(vault);
    const prepared = preparedSidecarWrite(completeSidecar(), "phone");
    await expect(
      repository.createIfAbsent("../A.inkbook.json", prepared),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(repository.readRaw("Notes/A.md")).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(vault.createCalls).toBe(0);
  });
});
