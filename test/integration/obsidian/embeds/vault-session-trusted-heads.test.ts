import { describe, expect, it } from "vitest";

import { TrustedDocumentHeadLedger } from "../../../../src/obsidian/storage/trusted-document-head-ledger";
import { inspectTrustedSvgOutput } from "../../../../src/persistence/scheduling/trusted-svg-output";
import {
  createVaultSessionFactory,
  documentFromSnapshot,
  emptySnapshot,
  operation,
  persistenceHarness,
  readOnlyDocumentVault,
} from "./vault-session-fixtures";

const TRUSTED_HASH = "a".repeat(64);

describe("vault session trusted-document-head boundary", () => {
  it("does not adopt a validated lower-revision document", async () => {
    const { actual, factory, file, trustedHeads } = await trustedHeadHarness(8);
    const session = factory.create({ documentId: file.path, sessionId: "session-1" });

    await expect(session.unlock(operation())).resolves.toMatchObject({
      actualSourceIdentity: { outputHash: actual.outputHash, revision: 7 },
      status: "source-changed",
    });
    expect(factory.getDocumentModel("session-1")).toBeUndefined();
    expect(
      trustedHeads.reconcile({
        documentId: file.path,
        outputHash: TRUSTED_HASH,
        revision: 8,
      }),
    ).toMatchObject({ status: "unchanged" });

    await expect(
      session.unlock({
        ...operation(),
        expectedSourceIdentity: { outputHash: actual.outputHash, revision: 7 },
        operationId: 2,
      }),
    ).resolves.toMatchObject({ status: "active" });
    expect(factory.getDocumentModel("session-1")).toBeDefined();
  });

  it("does not adopt a validated same-revision document with another hash", async () => {
    const { actual, factory, file } = await trustedHeadHarness(7);

    await expect(
      factory.create({ documentId: file.path, sessionId: "session-1" }).unlock(operation()),
    ).resolves.toMatchObject({
      actualSourceIdentity: { outputHash: actual.outputHash, revision: 7 },
      status: "source-changed",
    });
    expect(factory.getDocumentModel("session-1")).toBeUndefined();
  });

  it("requires explicit recovery before adopting an externally rolled-back active document", async () => {
    let stored: unknown;
    const trustedHeads = new TrustedDocumentHeadLedger({
      loadLocalStorage: () => stored,
      saveLocalStorage: (_key, data) => {
        stored = structuredClone(data);
      },
    });
    const harness = persistenceHarness(emptySnapshot(), { trustedHeads });
    await expect(harness.session.unlock(operation())).resolves.toMatchObject({ status: "active" });
    harness.replaceExternal(
      documentFromSnapshot({
        ...emptySnapshot(),
        revision: 6,
      }),
    );

    await expect(
      harness.factory.notifyExternalChange("drawings/ink.svg", {
        ...operation(),
        operationId: 2,
      }),
    ).resolves.toBe("reload-failed");
    expect(harness.factory.getDocumentModel("session-1")?.revision).toBe(7);

    await expect(
      harness.session.resolveRecovery("reload-external", {
        ...operation(),
        baseRevision: 7,
        operationId: 3,
      }),
    ).resolves.toMatchObject({ status: "confirmed" });
    expect(harness.factory.getDocumentModel("session-1")?.revision).toBe(6);
  });
});

async function trustedHeadHarness(revision: number) {
  let stored: unknown;
  const trustedHeads = new TrustedDocumentHeadLedger({
    loadLocalStorage: () => stored,
    saveLocalStorage: (_key, data) => {
      stored = structuredClone(data);
    },
  });
  trustedHeads.reconcile({
    documentId: "drawings/ink.svg",
    outputHash: TRUSTED_HASH,
    revision,
  });
  const document = documentFromSnapshot(emptySnapshot());
  const { file, vault } = readOnlyDocumentVault(document);
  const factory = createVaultSessionFactory(vault, undefined, undefined, { trustedHeads });
  return {
    actual: await inspectTrustedSvgOutput(document.svg),
    factory,
    file,
    trustedHeads,
  };
}
