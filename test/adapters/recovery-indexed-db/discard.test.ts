import { describe, expect, it } from "vitest";

import type { NoteIdentityV1 } from "../../../src/application/note-session";
import type {
  DiscardConfirmedNoteRecoveryV1,
  RecoverySnapshotV1,
  SidecarBaseIdentityV1,
} from "../../../src/application/recovery";
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
  removal,
} from "./support";

/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact session orders define the confirmed-discard CAS fixtures. */

function discardRequest(
  snapshot: RecoverySnapshotV1,
  noteIdentity: NoteIdentityV1 = NOTE,
  expectedBase: SidecarBaseIdentityV1 = BASE,
): DiscardConfirmedNoteRecoveryV1 {
  return Object.freeze({
    expectedAttempts: snapshot.attempts,
    expectedBase,
    expectedCheckpoints: snapshot.checkpoints,
    noteIdentity,
  });
}

async function loadSnapshot(
  store: Awaited<ReturnType<typeof openStore>>["store"],
  request = existingLoad(),
): Promise<RecoverySnapshotV1> {
  const loaded = await store.loadNote(request);
  if (!loaded.ok) throw new Error("Expected a recovery snapshot.");
  return loaded.value;
}

// eslint-disable-next-line max-lines-per-function -- The cohesive confirmed-reload CAS suite shares one exact snapshot fixture boundary.
describe("confirmed note recovery discard", () => {
  it("atomically removes the exact attempt and checkpoint snapshot across restart", async () => {
    const { store, factory } = await openStore("confirmed-discard");
    await store.prepareForward(preparedAttempt(1, 1));
    await store.appendSourceCheckpoint(checkpoint(1, 2));
    const snapshot = await loadSnapshot(store, {
      ...existingLoad(BASE, DIGEST_A, 5),
      currentMarkdownDigest: DIGEST_B,
    });

    await expect(
      store.discardConfirmedNoteRecovery(discardRequest(snapshot)),
    ).resolves.toEqual({ ok: true, value: undefined });
    await store.dispose();

    const reopened = await openStore("confirmed-discard", {}, factory);
    await expect(reopened.store.loadNote(existingLoad())).resolves.toEqual({
      ok: true,
      value: {
        attempts: [],
        checkpoints: [],
        relocations: [],
        removals: [],
      },
    });
    await reopened.store.dispose();
  });

  it("rejects a same-ID prepared-to-recorded race without deleting it", async () => {
    const { store } = await openStore("confirmed-discard-race");
    const attempt = preparedAttempt();
    await store.prepareForward(attempt);
    const staleSnapshot = await loadSnapshot(store);
    await store.recordForward(attempt.attemptId, hostAcknowledgement());

    await expect(
      store.discardConfirmedNoteRecovery(discardRequest(staleSnapshot)),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await expect(store.loadNote(existingLoad())).resolves.toMatchObject({
      ok: true,
      value: { attempts: [{ kind: "host-recorded-forward" }] },
    });
    await store.dispose();
  });

  it("uses the note index and leaves another note untouched", async () => {
    const { store, factory } = await openStore("confirmed-discard-isolation");
    const otherNote = Object.freeze({
      vaultIdHint: NOTE.vaultIdHint,
      vaultRelativeMarkdownPath: "notes/other.md",
    });
    const otherBase = Object.freeze({
      ...BASE,
      markdownPath: otherNote.vaultRelativeMarkdownPath,
      vaultRelativePath: "notes/other.inkbook.json",
    });
    await store.prepareForward(preparedAttempt(1, 1));
    await store.prepareForward(preparedAttempt(2, 1, otherBase));
    const snapshot = await loadSnapshot(store);

    await expect(
      store.discardConfirmedNoteRecovery(discardRequest(snapshot)),
    ).resolves.toEqual({ ok: true, value: undefined });
    await store.dispose();

    const reopened = await openStore(
      "confirmed-discard-isolation",
      {},
      factory,
    );
    await expect(
      reopened.store.loadNote(existingLoad(otherBase, DIGEST_A, 4)),
    ).resolves.toMatchObject({
      ok: true,
      value: { attempts: [{ attemptId: preparedAttempt(2).attemptId }] },
    });
    await reopened.store.dispose();
  });

  it("fails closed while a note relocation or removal saga is active", async () => {
    const { store } = await openStore("confirmed-discard-active-saga");
    await store.prepareForward(preparedAttempt());
    await store.beginRemoval(removal());
    const snapshot = await loadSnapshot(store);

    await expect(
      store.discardConfirmedNoteRecovery(discardRequest(snapshot)),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await expect(store.loadNote(existingLoad())).resolves.toMatchObject({
      ok: true,
      value: { attempts: [{}], removals: [{ kind: "annotation-removal" }] },
    });
    await store.dispose();
  });

  it("rejects accessor-backed discard requests without invoking them", async () => {
    const { store } = await openStore("confirmed-discard-accessors");
    let invoked = false;
    const request = Object.defineProperty({}, "expectedAttempts", {
      enumerable: true,
      get: () => {
        invoked = true;
        return [];
      },
    }) as DiscardConfirmedNoteRecoveryV1;
    await expect(store.discardConfirmedNoteRecovery(request)).resolves.toEqual({
      ok: false,
      code: "invalid-command",
    });
    const attempts = [preparedAttempt()];
    Object.defineProperty(attempts, "0", {
      enumerable: true,
      get: () => {
        invoked = true;
        return preparedAttempt();
      },
    });
    await expect(
      store.discardConfirmedNoteRecovery({
        expectedAttempts: attempts,
        expectedBase: BASE,
        expectedCheckpoints: [],
        noteIdentity: NOTE,
      }),
    ).resolves.toEqual({ ok: false, code: "invalid-command" });
    expect(invoked).toBe(false);
    await store.dispose();
  });
});
