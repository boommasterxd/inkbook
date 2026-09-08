import { describe, expect, it, vi } from "vitest";

import {
  MAXIMUM_TRUSTED_DOCUMENT_HEADS,
  TRUSTED_DOCUMENT_HEADS_STORAGE_KEY,
  TrustedDocumentHeadLedger,
  type DeviceLocalStoragePort,
  type TrustedDocumentHead,
} from "../../../../src/obsidian/storage/trusted-document-head-ledger";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function head(
  documentId = "drawings/example.svg",
  revision = 7,
  outputHash = HASH_A,
): TrustedDocumentHead {
  return { documentId, outputHash, revision };
}

function storage(
  initial?: unknown,
): DeviceLocalStoragePort & { readonly save: ReturnType<typeof vi.fn> } {
  let value = initial;
  const save = vi.fn((_key: string, next: unknown) => {
    value = structuredClone(next);
  });
  return {
    loadLocalStorage: () => structuredClone(value),
    save,
    saveLocalStorage: save,
  };
}

describe("TrustedDocumentHeadLedger", () => {
  it("creates, reuses, and advances a trusted head", () => {
    const port = storage();
    const ledger = new TrustedDocumentHeadLedger(port);

    expect(ledger.reconcile(head())).toEqual({ head: head(), status: "created" });
    expect(ledger.reconcile(head())).toEqual({ head: head(), status: "unchanged" });
    expect(ledger.reconcile(head(undefined, 8, HASH_B))).toEqual({
      head: head(undefined, 8, HASH_B),
      status: "advanced",
    });
    expect(port.save).toHaveBeenCalledTimes(2);
  });

  it("fails closed for a lower revision without replacing the trusted head", () => {
    const port = storage();
    const ledger = new TrustedDocumentHeadLedger(port);
    ledger.reconcile(head());

    expect(ledger.reconcile(head(undefined, 6, HASH_B))).toEqual({
      observed: head(undefined, 6, HASH_B),
      reason: "lower-revision",
      status: "external-version",
      trusted: head(),
    });
    expect(ledger.reconcile(head())).toMatchObject({ status: "unchanged" });
    expect(port.save).toHaveBeenCalledOnce();
  });

  it("fails closed for a different hash at the trusted revision", () => {
    const ledger = new TrustedDocumentHeadLedger(storage());
    ledger.reconcile(head());

    expect(ledger.reconcile(head(undefined, 7, HASH_B))).toEqual({
      observed: head(undefined, 7, HASH_B),
      reason: "same-revision-different-hash",
      status: "external-version",
      trusted: head(),
    });
  });

  it("replaces a conflicting head only through explicit recovery acceptance", () => {
    const port = storage();
    const ledger = new TrustedDocumentHeadLedger(port);
    ledger.reconcile(head());
    const external = head(undefined, 6, HASH_B);

    expect(ledger.acceptExternalVersion(external)).toEqual({
      head: external,
      status: "accepted",
    });
    expect(new TrustedDocumentHeadLedger(port).reconcile(external)).toEqual({
      head: external,
      status: "unchanged",
    });
  });

  it("records a read-back-confirmed canonical rewrite but not an older save", () => {
    const ledger = new TrustedDocumentHeadLedger(storage());
    ledger.reconcile(head());

    expect(ledger.recordConfirmed(head(undefined, 7, HASH_B))).toEqual({
      head: head(undefined, 7, HASH_B),
      status: "confirmed",
    });
    expect(ledger.recordConfirmed(head(undefined, 6, HASH_A))).toMatchObject({
      reason: "lower-revision",
      status: "external-version",
    });
  });
});

describe("TrustedDocumentHeadLedger storage boundary", () => {
  it("fails closed when stored data or a candidate is invalid", () => {
    const malformed = new TrustedDocumentHeadLedger(storage({ heads: [], version: 2 }));
    expect(malformed.reconcile(head())).toEqual({ operation: "validate", status: "storage-error" });

    const ledger = new TrustedDocumentHeadLedger(storage());
    expect(ledger.reconcile(head(undefined, -1, "not-a-hash"))).toEqual({
      operation: "validate",
      status: "storage-error",
    });
  });

  it("does not trust an advancement when device storage rejects the write", () => {
    const initial = { heads: [head()], version: 1 };
    const ledger = new TrustedDocumentHeadLedger({
      loadLocalStorage: () => initial,
      saveLocalStorage: () => {
        throw new Error("quota exceeded");
      },
    });

    expect(ledger.reconcile(head(undefined, 8, HASH_B))).toEqual({
      operation: "save",
      status: "storage-error",
    });
    expect(ledger.reconcile(head())).toMatchObject({ status: "unchanged" });
  });

  it("rejects duplicate and over-limit persisted entries", () => {
    const duplicate = { heads: [head(), head()], version: 1 };
    const tooMany = {
      heads: Array.from({ length: MAXIMUM_TRUSTED_DOCUMENT_HEADS + 1 }, (_, index) =>
        head(`drawings/${index}.svg`),
      ),
      version: 1,
    };

    expect(new TrustedDocumentHeadLedger(storage(duplicate)).reconcile(head())).toMatchObject({
      operation: "validate",
      status: "storage-error",
    });
    expect(new TrustedDocumentHeadLedger(storage(tooMany)).reconcile(head())).toMatchObject({
      operation: "validate",
      status: "storage-error",
    });
  });

  it("reports a public device-storage read failure", () => {
    const ledger = new TrustedDocumentHeadLedger({
      loadLocalStorage: () => {
        throw new Error("unavailable");
      },
      saveLocalStorage: vi.fn(),
    });

    expect(ledger.reconcile(head())).toEqual({ operation: "load", status: "storage-error" });
  });

  it("uses the versioned device-local storage key", () => {
    const port = storage();
    new TrustedDocumentHeadLedger(port).reconcile(head());

    expect(port.save).toHaveBeenCalledWith(
      TRUSTED_DOCUMENT_HEADS_STORAGE_KEY,
      expect.objectContaining({ version: 1 }),
    );
  });

  it("stores an immutable bounded projection of an untrusted candidate", () => {
    const port = storage();
    const ledger = new TrustedDocumentHeadLedger(port);
    const candidate = { ...head(), ignored: "not persisted" };
    ledger.reconcile(candidate);
    candidate.revision = 1;

    expect(ledger.reconcile(head())).toMatchObject({ status: "unchanged" });
    expect(port.save).toHaveBeenCalledWith(TRUSTED_DOCUMENT_HEADS_STORAGE_KEY, {
      heads: [head()],
      version: 1,
    });
  });
});
