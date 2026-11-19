import { describe, expect, it } from "vitest";

import {
  MAXIMUM_TRUSTED_DOCUMENT_HEADS,
  TRUSTED_DOCUMENT_HEADS_STORAGE_KEY,
  TrustedDocumentHeadLedger,
  type DeviceLocalStoragePort,
} from "../../../../src/obsidian/storage/trusted-document-head-ledger";

class ObsidianLocalStorageFake implements DeviceLocalStoragePort {
  readonly #values = new Map<string, unknown>();

  public loadLocalStorage(key: string): unknown {
    return structuredClone(this.#values.get(key));
  }

  public saveLocalStorage(key: string, data: unknown): void {
    this.#values.set(key, structuredClone(data));
  }
}

function outputHash(index: number): string {
  return index.toString(16).padStart(64, "0");
}

describe("trusted document heads through the Obsidian device-storage boundary", () => {
  it("migrates readable legacy paths while preserving separate trusted heads on reopen", async () => {
    const appStorage = new ObsidianLocalStorageFake();
    const prefix = "drawings/document ";
    const legacy = [
      { documentId: `${prefix}\ud800.svg`, outputHash: outputHash(3), revision: 10 },
      { documentId: `${prefix}�.svg`, outputHash: outputHash(7), revision: 21 },
    ];
    appStorage.saveLocalStorage(TRUSTED_DOCUMENT_HEADS_STORAGE_KEY, { heads: legacy, version: 1 });

    await expect(new TrustedDocumentHeadLedger(appStorage).ready()).resolves.toBeUndefined();
    const stored = appStorage.loadLocalStorage(TRUSTED_DOCUMENT_HEADS_STORAGE_KEY);
    expect(JSON.stringify(stored)).not.toContain(prefix);
    expect(stored).toMatchObject({ version: 2 });
    const restarted = new TrustedDocumentHeadLedger(appStorage);
    expect(restarted.reconcile(legacy[0]!)).toMatchObject({ status: "unchanged" });
    expect(restarted.reconcile({ ...legacy[1]!, revision: 20 })).toMatchObject({
      reason: "lower-revision",
      status: "external-version",
      trusted: legacy[1],
    });
  });

  it("keeps a newer version saved by another runtime while legacy hashing is suspended", async () => {
    const appStorage = new ObsidianLocalStorageFake();
    const legacy = { documentId: "drawing.svg", outputHash: outputHash(11), revision: 9 };
    appStorage.saveLocalStorage(TRUSTED_DOCUMENT_HEADS_STORAGE_KEY, {
      heads: [legacy],
      version: 1,
    });
    let resume!: () => void;
    let checkpoint: Promise<void> | undefined = new Promise<void>((resolve) => (resume = resolve));
    const first = new TrustedDocumentHeadLedger(appStorage, () => {
      const pending = checkpoint;
      checkpoint = undefined;
      return pending;
    });
    const migration = first.ready();
    const second = new TrustedDocumentHeadLedger(appStorage);
    await second.ready();
    const advanced = { ...legacy, outputHash: outputHash(12), revision: 10 };
    expect(second.reconcile(advanced)).toMatchObject({ status: "advanced" });

    resume();
    await expect(migration).resolves.toBeUndefined();
    expect(first.reconcile(legacy)).toMatchObject({ reason: "lower-revision", trusted: advanced });
    expect(new TrustedDocumentHeadLedger(appStorage).reconcile(advanced)).toMatchObject({
      status: "unchanged",
    });
  });
});

describe("trusted document head retention across Obsidian restarts", () => {
  it("retains conflicts and advances across plugin-runtime restarts", () => {
    const appStorage = new ObsidianLocalStorageFake();
    const firstRuntime = new TrustedDocumentHeadLedger(appStorage);
    firstRuntime.reconcile({ documentId: "drawing.svg", outputHash: outputHash(1), revision: 10 });

    const restartedRuntime = new TrustedDocumentHeadLedger(appStorage);
    expect(
      restartedRuntime.reconcile({
        documentId: "drawing.svg",
        outputHash: outputHash(2),
        revision: 10,
      }),
    ).toMatchObject({ reason: "same-revision-different-hash", status: "external-version" });
    expect(
      restartedRuntime.reconcile({
        documentId: "drawing.svg",
        outputHash: outputHash(3),
        revision: 11,
      }),
    ).toMatchObject({ status: "advanced" });
    expect(
      new TrustedDocumentHeadLedger(appStorage).reconcile({
        documentId: "drawing.svg",
        outputHash: outputHash(3),
        revision: 11,
      }),
    ).toMatchObject({ status: "unchanged" });
  });

  it("evicts the oldest head while retaining the fixed device-storage bound", () => {
    const appStorage = new ObsidianLocalStorageFake();
    const ledger = new TrustedDocumentHeadLedger(appStorage);
    for (let index = 0; index <= MAXIMUM_TRUSTED_DOCUMENT_HEADS; index += 1) {
      ledger.reconcile({
        documentId: `drawings/${index}.svg`,
        outputHash: outputHash(index),
        revision: index,
      });
    }

    const restarted = new TrustedDocumentHeadLedger(appStorage);
    expect(
      restarted.reconcile({ documentId: "drawings/0.svg", outputHash: outputHash(9), revision: 0 }),
    ).toMatchObject({ status: "created" });
    expect(
      restarted.reconcile({
        documentId: "drawings/128.svg",
        outputHash: outputHash(9),
        revision: 1,
      }),
    ).toMatchObject({ reason: "lower-revision", status: "external-version" });
  });
});
