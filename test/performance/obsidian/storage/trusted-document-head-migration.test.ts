import { expect, it, vi } from "vitest";
import {
  MAXIMUM_TRUSTED_DOCUMENT_HEADS,
  TRUSTED_DOCUMENT_HEADS_STORAGE_KEY,
  TrustedDocumentHeadLedger,
} from "../../../../src/obsidian/storage/trusted-document-head-ledger";
import * as sha256 from "../../../../src/persistence/serialization/sha256";

it("shares one admitted migration, hashes each bounded legacy path once, and writes only on completion", async () => {
  const heads = Array.from({ length: MAXIMUM_TRUSTED_DOCUMENT_HEADS }, (_, index) => ({
    documentId: `${index}${"\ud800".repeat(4088)}.svg`,
    outputHash: "a".repeat(64),
    revision: index,
  }));
  let stored: unknown = { heads, version: 1 };
  const load = vi.fn(() => stored);
  const save = vi.fn((_key: string, value: unknown) => (stored = value));
  const hash = vi.spyOn(sha256, "sha256Hex");
  let resume!: () => void;
  const admission = new Promise<void>((resolve) => (resume = resolve));
  const checkpoint = vi.fn((): Promise<void> | undefined => undefined);
  checkpoint.mockReturnValueOnce(admission);
  const ledger = new TrustedDocumentHeadLedger(
    { loadLocalStorage: load, saveLocalStorage: save },
    checkpoint,
  );

  const migration = ledger.ready();
  expect(ledger.ready()).toBe(migration);
  expect(hash).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  resume();
  await expect(migration).resolves.toBeUndefined();

  expect(hash).toHaveBeenCalledTimes(MAXIMUM_TRUSTED_DOCUMENT_HEADS);
  expect(hash.mock.calls.every(([payload]) => payload.length <= 6 * 4096 + 64)).toBe(true);
  expect(checkpoint).toHaveBeenCalledTimes(MAXIMUM_TRUSTED_DOCUMENT_HEADS + 1);
  expect(save).toHaveBeenCalledExactlyOnceWith(
    TRUSTED_DOCUMENT_HEADS_STORAGE_KEY,
    expect.objectContaining({ version: 2 }),
  );
  expect(load).toHaveBeenCalledTimes(3);
  expect(ledger.ready()).toBeUndefined();
});
