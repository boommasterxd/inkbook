/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact source-chain generations and lengths are under test. */
import { describe, expect, it } from "vitest";

import {
  createSourceGeneration,
  parseSha256Digest,
} from "../../../src/application/note-session";
import type { SourceCheckpointOperationV1 } from "../../../src/application/source-coordination";
import {
  BASE,
  DIGEST_A,
  DIGEST_B,
  NOTE,
  checkpoint,
  existingLoad,
  hostAcknowledgement,
  openStore,
  preparedAttempt,
} from "./support";

const DIGEST_C = parseSha256Digest("c".repeat(64));

describe("IndexedDB recovery load validation", () => {
  it("selects the root checkpoint prefix while retaining later durable checkpoints", async () => {
    const { store } = await openStore("checkpoint-root-prefix");
    await appendTwoCheckpointChain(store);
    await expect(
      store.loadNote(rootedLoad(DIGEST_A, 4)),
    ).resolves.toMatchObject({
      ok: true,
      value: { checkpoints: [] },
    });
    await store.dispose();
  });

  it("selects one intermediate checkpoint prefix", async () => {
    const { store } = await openStore("checkpoint-intermediate-prefix");
    const [first] = await appendTwoCheckpointChain(store);
    await expect(
      store.loadNote(rootedLoad(DIGEST_B, 5)),
    ).resolves.toMatchObject({
      ok: true,
      value: { checkpoints: [{ checkpointId: first.checkpointId }] },
    });
    await store.dispose();
  });

  it("selects the complete checkpoint prefix at the terminal node", async () => {
    const { store } = await openStore("checkpoint-terminal-prefix");
    const [first, second] = await appendTwoCheckpointChain(store);
    await expect(
      store.loadNote(rootedLoad(DIGEST_C, 6)),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        checkpoints: [
          { checkpointId: first.checkpointId },
          { checkpointId: second.checkpointId },
        ],
      },
    });
    await store.dispose();
  });

  it("fails closed on checkpoint forks, gaps, and ambiguous matching nodes", async () => {
    const forked = await openStore("checkpoint-fork");
    await forked.store.appendSourceCheckpoint(checkpoint(1, 1));
    await forked.store.appendSourceCheckpoint(checkpoint(2, 2));
    await expect(
      forked.store.loadNote(rootedLoad(DIGEST_B, 5)),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await forked.store.dispose();

    const gapped = await openStore("checkpoint-gap");
    await gapped.store.appendSourceCheckpoint(secondCheckpoint());
    await expect(
      gapped.store.loadNote(rootedLoad(DIGEST_C, 6)),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await gapped.store.dispose();

    const ambiguous = await openStore("checkpoint-ambiguous-node");
    await ambiguous.store.appendSourceCheckpoint(checkpoint(1, 1));
    await ambiguous.store.appendSourceCheckpoint(
      secondCheckpoint({
        offsetMap: {
          spans: [
            {
              newFromUtf16: 1,
              newToUtf16: 1,
              oldFromUtf16: 1,
              oldToUtf16: 2,
            },
          ],
        },
        replacementDigest: DIGEST_A,
        replacementUtf16Length: 4,
      }),
    );
    await expect(
      ambiguous.store.loadNote(rootedLoad(DIGEST_A, 4)),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await ambiguous.store.dispose();
  });
});

describe("IndexedDB recovery request validation", () => {
  it("validates one contiguous checkpoint chain and attempt source nodes", async () => {
    const { store } = await openStore("checkpoint-chain");
    await store.prepareForward(preparedAttempt(1, 1));
    await store.appendSourceCheckpoint(checkpoint(1, 2));
    await store.prepareForward({
      ...preparedAttempt(2, 3, BASE, 2),
      expectedSourceDigest: DIGEST_B,
      expectedSourceGeneration: createSourceGeneration(2),
    });
    const request = existingLoad(BASE, DIGEST_B, 5);
    if (request.kind !== "existing-sidecar")
      throw new Error("Invalid fixture.");
    await expect(
      store.loadNote({
        ...request,
        validatedSidecarSourceDigest: DIGEST_A,
        validatedSidecarSourceGeneration: createSourceGeneration(1),
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { attempts: [{ sessionOrder: 1 }, { sessionOrder: 3 }] },
    });
    await store.dispose();
  });

  it("rejects attempts that reference a source node reached later in SessionOrder", async () => {
    const { store } = await openStore("future-source-node-attempt");
    await store.prepareForward({
      ...preparedAttempt(1, 1, BASE, 2),
      expectedSourceDigest: DIGEST_B,
      expectedSourceGeneration: createSourceGeneration(2),
    });
    await store.appendSourceCheckpoint(checkpoint(1, 2));
    const request = existingLoad(BASE, DIGEST_B, 5);
    if (request.kind !== "existing-sidecar") {
      throw new Error("Invalid fixture.");
    }

    await expect(
      store.loadNote({
        ...request,
        validatedSidecarSourceDigest: DIGEST_A,
        validatedSidecarSourceGeneration: createSourceGeneration(1),
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await store.dispose();
  });
});

describe("IndexedDB recovery load command validation", () => {
  it("bounds prefix-index queries for deeply segmented paths", async () => {
    const { store } = await openStore("prefix-query-bound");
    const markdownPath = `${"a/".repeat(129)}note.md`;
    const base = {
      ...BASE,
      markdownPath,
      vaultRelativePath: `${"a/".repeat(129)}note.inkbook.json`,
    };

    await expect(
      store.loadNote({
        ...existingLoad(base),
        noteIdentity: { ...NOTE, vaultRelativeMarkdownPath: markdownPath },
      }),
    ).resolves.toEqual({ ok: false, code: "recovery-limit" });
    await store.dispose();
  });

  it("rejects unrelated current digests, invalid lengths, and stale sidecar bases", async () => {
    const { store } = await openStore("invalid-load-evidence");
    await store.prepareForward(preparedAttempt());
    await expect(
      store.loadNote({
        ...existingLoad(),
        currentMarkdownDigest: parseSha256Digest("c".repeat(64)),
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await expect(
      store.loadNote({
        ...existingLoad(),
        currentMarkdownUtf16Length: -1,
      }),
    ).resolves.toEqual({ ok: false, code: "invalid-command" });
    await expect(
      store.loadNote({
        ...existingLoad(),
        base: { ...BASE, markdownPath: "notes/other.md" },
      }),
    ).resolves.toEqual({ ok: false, code: "invalid-command" });
    await store.dispose();
  });

  it("supports only the null-base absent-first-sidecar load variant", async () => {
    const { store } = await openStore("absent-first-sidecar");
    const base = {
      ...BASE,
      rawTextSha256: null,
      revision: null,
    };
    const attempt = { ...preparedAttempt(1, 1, base, 0), base };
    await store.prepareForward(attempt);
    await store.recordForward(attempt.attemptId, hostAcknowledgement());
    await expect(
      store.loadNote({
        base,
        currentMarkdownDigest: DIGEST_A,
        currentMarkdownUtf16Length: 4,
        expectedVaultRelativePath: base.vaultRelativePath,
        kind: "absent-first-sidecar",
        noteIdentity: NOTE,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { attempts: [{ kind: "host-recorded-forward" }] },
    });
    await expect(
      store.loadNote({
        base: BASE,
        currentMarkdownDigest: DIGEST_A,
        currentMarkdownUtf16Length: 4,
        expectedVaultRelativePath: BASE.vaultRelativePath,
        kind: "absent-first-sidecar",
        noteIdentity: NOTE,
      }),
    ).resolves.toEqual({ ok: false, code: "invalid-command" });
    await store.dispose();
  });
});

async function appendTwoCheckpointChain(
  store: Awaited<ReturnType<typeof openStore>>["store"],
): Promise<
  readonly [SourceCheckpointOperationV1, SourceCheckpointOperationV1]
> {
  const first = checkpoint(1, 1);
  const second = secondCheckpoint();
  await store.appendSourceCheckpoint(first);
  await store.appendSourceCheckpoint(second);
  return [first, second];
}

function secondCheckpoint(
  overrides: Partial<SourceCheckpointOperationV1> = {},
): SourceCheckpointOperationV1 {
  return {
    ...checkpoint(2, 2),
    priorDigest: DIGEST_B,
    priorGeneration: createSourceGeneration(2),
    priorUtf16Length: 5,
    replacementDigest: DIGEST_C,
    replacementGeneration: createSourceGeneration(3),
    replacementUtf16Length: 6,
    ...overrides,
  };
}

function rootedLoad(
  currentDigest: typeof DIGEST_A,
  currentMarkdownUtf16Length: number,
): ReturnType<typeof existingLoad> {
  const request = existingLoad(BASE, currentDigest, currentMarkdownUtf16Length);
  if (request.kind !== "existing-sidecar") return request;
  return {
    ...request,
    validatedSidecarSourceDigest: DIGEST_A,
    validatedSidecarSourceGeneration: createSourceGeneration(1),
  };
}
