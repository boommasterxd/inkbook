/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact saga steps and identities are persistence fixtures. */
import { describe, expect, it } from "vitest";

import { sha256Bytes } from "../../../src/domain/codecs/sha256";
import {
  encodeRecoveryRecordV1,
  type RecoveryLoadRequestV1,
} from "../../../src/application/recovery";
import {
  createSidecarRevision,
  createSourceGeneration,
  parseRelocationId,
  parseSha256Digest,
} from "../../../src/application/note-session";
import { createSceneRevision } from "../../../src/domain/model";
import {
  BASE,
  DIGEST_A,
  NEXT_BASE,
  NOTE,
  existingLoad,
  fileRelocation,
  idPayload,
  openStore,
  prefixRelocation,
  preparedAttempt,
  removal,
} from "./support";

// eslint-disable-next-line max-lines-per-function -- The saga scenarios form one cohesive adapter contract suite.
describe("IndexedDB recovery sagas", () => {
  it("compare-and-swaps every file relocation step and completes by canonical digest", async () => {
    const { store } = await openStore("file-relocation");
    const prepared = fileRelocation();
    const moved = fileRelocation("sidecar-moved");
    await expect(store.beginRelocation(prepared)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(
      store.advanceRelocation({ expected: prepared, replacement: moved }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await expect(
      store.advanceRelocation({
        expected: prepared,
        replacement: fileRelocation("identities-rekeyed"),
      }),
    ).resolves.toEqual({ ok: false, code: "invalid-command" });

    let current = moved;
    for (const step of [
      "identities-rekeyed",
      "sidecar-metadata-saved",
      "marker-saved",
      "checkpoint-acknowledged",
      "complete",
    ] as const) {
      const replacement = fileRelocation(step);
      await store.advanceRelocation({ expected: current, replacement });
      current = replacement;
    }
    const encoded = encodeRecoveryRecordV1(current);
    if (!encoded.ok) throw new Error("Expected terminal relocation encoding.");
    await expect(
      store.completeSaga({
        expectedTerminalRecordSha256: parseSha256Digest(
          await sha256Bytes(encoded.value),
        ),
        id: current.relocationId,
        kind: "relocation",
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await store.dispose();
  });

  it("persists removal signal ordering and refuses non-terminal completion", async () => {
    const { store } = await openStore("removal");
    const start = removal();
    const event = removal({ deleteEventAcknowledged: true });
    await store.beginRemoval(start);
    await store.advanceRemoval({ expected: start, replacement: event });
    const encoded = encodeRecoveryRecordV1(event);
    if (!encoded.ok) throw new Error("Expected removal encoding.");
    await expect(
      store.completeSaga({
        expectedTerminalRecordSha256: parseSha256Digest(
          await sha256Bytes(encoded.value),
        ),
        id: event.removalId,
        kind: "removal",
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await expect(store.loadNote(existingLoad())).resolves.toMatchObject({
      ok: true,
      value: { removals: [{ deleteEventAcknowledged: true }] },
    });
    await store.dispose();
  });

  it("completes a fully acknowledged removal and a zero-work prefix saga", async () => {
    const { store } = await openStore("terminal-sagas");
    const start = removal();
    const removing = removal({
      deleteEventAcknowledged: true,
      markerState: "removing",
      trashAcknowledged: true,
    });
    const removed = removal({
      deleteEventAcknowledged: true,
      markerState: "removed",
      trashAcknowledged: true,
    });
    await store.beginRemoval(start);
    await store.advanceRemoval({ expected: start, replacement: removing });
    await store.advanceRemoval({ expected: removing, replacement: removed });
    const removalBytes = encodeRecoveryRecordV1(removed);
    if (!removalBytes.ok) throw new Error("Expected removal encoding.");
    await expect(
      store.completeSaga({
        expectedTerminalRecordSha256: parseSha256Digest(
          await sha256Bytes(removalBytes.value),
        ),
        id: removed.removalId,
        kind: "removal",
      }),
    ).resolves.toEqual({ ok: true, value: undefined });

    const prefix = prefixRelocation();
    const complete = { ...prefix, step: "complete" as const };
    await store.beginRelocation(prefix);
    await store.advanceRelocation({ expected: prefix, replacement: complete });
    const prefixBytes = encodeRecoveryRecordV1(complete);
    if (!prefixBytes.ok) throw new Error("Expected prefix encoding.");
    await expect(
      store.completeSaga({
        expectedTerminalRecordSha256: parseSha256Digest(
          await sha256Bytes(prefixBytes.value),
        ),
        id: complete.relocationId,
        kind: "relocation",
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await store.dispose();
  });

  it("loads prefix sagas only through matching segment-prefix indices", async () => {
    const { store } = await openStore("prefix-index");
    await store.beginRelocation(prefixRelocation());
    await store.beginRelocation({
      ...prefixRelocation(),
      priorPrefix: "unrelated",
      relocationId: parseRelocationId(`rel_${idPayload(3)}`),
    });
    await expect(store.loadNote(existingLoad())).resolves.toMatchObject({
      ok: true,
      value: { relocations: [{ priorPrefix: "notes" }] },
    });
    await store.dispose();
  });

  it("atomically rekeys note records and their sidecar base under the durable relocation identity", async () => {
    const { store } = await openStore("note-rekey");
    const saga = fileRelocation();
    await store.beginRelocation(saga);
    await store.prepareForward(preparedAttempt());
    const replacementNote = {
      ...NOTE,
      vaultRelativeMarkdownPath: "notes/destination.md",
    };
    await expect(
      store.rekeyNote({
        prior: NOTE,
        relocationId: saga.relocationId,
        replacement: replacementNote,
      }),
    ).resolves.toEqual({ ok: true, value: undefined });

    const rekeyedBase = {
      ...BASE,
      markdownPath: replacementNote.vaultRelativeMarkdownPath,
      vaultRelativePath: saga.destinationSidecarPath,
    };
    const baseRequest = existingLoad(rekeyedBase);
    if (baseRequest.kind !== "existing-sidecar") {
      throw new Error("Expected existing-sidecar load request.");
    }
    const request: RecoveryLoadRequestV1 = {
      ...baseRequest,
      noteIdentity: replacementNote,
      validatedSidecarSourceDigest: DIGEST_A,
    };
    await expect(store.loadNote(request)).resolves.toMatchObject({
      ok: true,
      value: {
        attempts: [{ base: { markdownPath: "notes/destination.md" } }],
        relocations: [{ noteIdentity: replacementNote }],
      },
    });
    await expect(store.loadNote(existingLoad())).resolves.toMatchObject({
      ok: true,
      value: { attempts: [], removals: [] },
    });
    await store.dispose();
  });

  it("rejects rekey when a concurrent session appends to the prior note", async () => {
    const name = "concurrent-note-rekey";
    const { store: first, factory } = await openStore(name);
    const { store: second } = await openStore(name, {}, factory);
    const saga = fileRelocation();
    await first.beginRelocation(saga);
    await first.prepareForward(preparedAttempt());
    const replacement = {
      ...NOTE,
      vaultRelativeMarkdownPath: saga.destinationMarkdownPath,
    };

    const rekey = first.rekeyNote({
      prior: NOTE,
      relocationId: saga.relocationId,
      replacement,
    });
    const appended = second.prepareForward(preparedAttempt(2, 2));

    await expect(appended).resolves.toEqual({ ok: true, value: undefined });
    await expect(rekey).resolves.toEqual({
      ok: false,
      code: "sidecar-conflict",
    });
    await expect(first.loadNote(existingLoad())).resolves.toMatchObject({
      ok: true,
      value: { attempts: [{}, {}] },
    });
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it("authorizes prefix rekey only for one complete-segment mapping", async () => {
    const { store } = await openStore("prefix-rekey");
    const prefix = prefixRelocation();
    await store.beginRelocation(prefix);
    await store.prepareForward(preparedAttempt());
    const replacement = {
      ...NOTE,
      vaultRelativeMarkdownPath: "archive/source.md",
    };
    await expect(
      store.rekeyNote({
        prior: NOTE,
        relocationId: prefix.relocationId,
        replacement,
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    await expect(
      store.rekeyNote({
        prior: replacement,
        relocationId: prefix.relocationId,
        replacement: {
          ...replacement,
          vaultRelativeMarkdownPath: "unrelated/source.md",
        },
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await store.dispose();
  });

  it("fails sidecar acknowledgement closed while a removal saga owns the base", async () => {
    const { store } = await openStore("removal-blocks-acknowledgement");
    await expect(store.beginRemoval(removal())).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(
      store.acknowledgeSidecar({
        acknowledgedReplacementBase: NEXT_BASE,
        coveredAttemptIds: [],
        coveredCheckpointIds: [],
        expectedPriorBase: BASE,
        noteIdentity: NOTE,
        sceneRevision: createSceneRevision(2),
        sidecarRevision: createSidecarRevision(2),
        sourceDigest: DIGEST_A,
        sourceGeneration: createSourceGeneration(1),
      }),
    ).resolves.toEqual({ ok: false, code: "recovery-unavailable" });
    await store.dispose();
  });
});
