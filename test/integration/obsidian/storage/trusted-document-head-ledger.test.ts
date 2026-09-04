import { describe, expect, it } from "vitest";

import {
  MAXIMUM_TRUSTED_DOCUMENT_HEADS,
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
