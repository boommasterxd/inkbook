/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact recovery revisions and session order define the removal CAS fixtures. */
import { describe, expect, it } from "vitest";

import type { NoteIdentityV1 } from "../../../src/application/note-session";
import {
  type ActiveRemovalRecoveryV1,
  type FinalizeRemovalRecoveryV1,
  type RecoveryStore,
  type RemovalRecordV1,
} from "../../../src/application/recovery";
import {
  BASE,
  NOTE,
  checkpoint,
  corruptStoredRecord,
  hostAcknowledgement,
  openStore,
  preparedAttempt,
  removal,
} from "./support";

describe("IndexedDB active removal recovery", () => {
  it("loads absent, active, and terminal bundles immutably across restart", async () => {
    const name = "active-removal-restart";
    const { store, factory } = await openStore(name);
    await expect(
      store.loadActiveRemoval({ noteIdentity: NOTE }),
    ).resolves.toEqual({
      ok: true,
      value: null,
    });
    const start = removal();
    await store.beginRemoval(start);
    await store.dispose();

    const reopened = await openStore(name, {}, factory);
    const active = await loadBundle(reopened.store);
    expect(active.removal).toEqual(start);
    expect(Object.isFrozen(active)).toBe(true);
    expect(Object.isFrozen(active.removal)).toBe(true);
    expect(Object.isFrozen(active.attempts)).toBe(true);
    const terminal = await persistTerminal(reopened.store, start);
    const completed = await loadBundle(reopened.store);
    expect(completed.removal).toEqual(terminal);
    await reopened.store.dispose();

    const terminalRestart = await openStore(name, {}, factory);
    await expect(
      terminalRestart.store.loadActiveRemoval({ noteIdentity: NOTE }),
    ).resolves.toMatchObject({
      ok: true,
      value: { removal: { markerState: "removed" } },
    });
    const bundle = await loadBundle(terminalRestart.store);
    await expect(
      terminalRestart.store.finalizeRemovalRecovery(finalizeRequest(bundle)),
    ).resolves.toEqual({ ok: true, value: undefined });
    await terminalRestart.store.dispose();

    const completedRestart = await openStore(name, {}, factory);
    await expect(
      completedRestart.store.loadActiveRemoval({ noteIdentity: NOTE }),
    ).resolves.toEqual({ ok: true, value: null });
    await completedRestart.store.dispose();
  });

  it("atomically removes an exact non-empty journal and terminal removal", async () => {
    const { store } = await openStore("finalize-removal-journal");
    const attempt = preparedAttempt(1, 1);
    const sourceCheckpoint = checkpoint(1, 2);
    await store.prepareForward(attempt);
    await store.appendSourceCheckpoint(sourceCheckpoint);
    await persistTerminal(store);
    const bundle = await loadBundle(store);
    expect(bundle.attempts).toEqual([attempt]);
    expect(bundle.checkpoints).toEqual([sourceCheckpoint]);

    await expect(
      store.finalizeRemovalRecovery(finalizeRequest(bundle)),
    ).resolves.toEqual({ ok: true, value: undefined });
    await expect(
      store.loadActiveRemoval({ noteIdentity: NOTE }),
    ).resolves.toEqual({
      ok: true,
      value: null,
    });
    await expect(
      store.finalizeRemovalRecovery(finalizeRequest(bundle)),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await store.dispose();
  });
});

describe("IndexedDB removal finalization compare-and-swap", () => {
  it("rejects stale terminal records, bases, and journal identities without deletion", async () => {
    const { store } = await openStore("finalize-removal-stale-cas");
    const attempt = preparedAttempt();
    await store.prepareForward(attempt);
    await persistTerminal(store);
    const bundle = await loadBundle(store);
    await expect(
      store.finalizeRemovalRecovery({
        ...finalizeRequest(bundle),
        expectedRemoval: {
          ...bundle.removal,
          deadlineEpochMs: bundle.removal.deadlineEpochMs + 1,
        },
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    const otherIdentity: NoteIdentityV1 = {
      ...NOTE,
      vaultRelativeMarkdownPath: "notes/other.md",
    };
    await expect(
      store.finalizeRemovalRecovery({
        expectedAttempts: [],
        expectedCheckpoints: [],
        expectedRemoval: {
          ...bundle.removal,
          noteIdentity: otherIdentity,
          sidecarBase: {
            ...BASE,
            markdownPath: otherIdentity.vaultRelativeMarkdownPath,
            vaultRelativePath: "notes/other.inkbook.json",
          },
        },
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await expect(
      store.finalizeRemovalRecovery({
        ...finalizeRequest(bundle),
        expectedAttempts: [],
      }),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await store.recordForward(attempt.attemptId, hostAcknowledgement());
    await expect(
      store.finalizeRemovalRecovery(finalizeRequest(bundle)),
    ).resolves.toEqual({ ok: false, code: "sidecar-conflict" });
    await expect(
      store.loadActiveRemoval({ noteIdentity: NOTE }),
    ).resolves.toMatchObject({
      ok: true,
      value: { removal: { removalId: bundle.removal.removalId } },
    });
    await store.dispose();
  });
});

describe("IndexedDB removal finalization validation", () => {
  it("fails closed for descriptor accessors, corruption, and disposal", async () => {
    const name = "finalize-removal-corruption";
    const { store, factory } = await openStore(name);
    const terminal = await persistTerminal(store);
    let invoked = false;
    const finalizeAccessor = Object.defineProperty({}, "expectedRemoval", {
      enumerable: true,
      get: () => {
        invoked = true;
        return terminal;
      },
    }) as FinalizeRemovalRecoveryV1;
    await expect(
      store.finalizeRemovalRecovery(finalizeAccessor),
    ).resolves.toEqual({
      ok: false,
      code: "invalid-command",
    });
    const loadAccessor = Object.defineProperty({}, "noteIdentity", {
      enumerable: true,
      get: () => {
        invoked = true;
        return NOTE;
      },
    }) as { noteIdentity: NoteIdentityV1 };
    await expect(store.loadActiveRemoval(loadAccessor)).resolves.toEqual({
      ok: false,
      code: "invalid-command",
    });
    expect(invoked).toBe(false);
    await store.dispose();

    await corruptStoredRecord(factory, name, `removal:${terminal.removalId}`);
    const corrupt = await openStore(name, {}, factory);
    await expect(
      corrupt.store.loadActiveRemoval({ noteIdentity: NOTE }),
    ).resolves.toEqual({ ok: false, code: "recovery-unavailable" });
    await expect(
      corrupt.store.finalizeRemovalRecovery({
        expectedAttempts: [],
        expectedCheckpoints: [],
        expectedRemoval: terminal,
      }),
    ).resolves.toEqual({ ok: false, code: "recovery-unavailable" });
    await corrupt.store.dispose();
    await expect(
      corrupt.store.loadActiveRemoval({ noteIdentity: NOTE }),
    ).resolves.toEqual({ ok: false, code: "disposed" });
  });
});

describe("IndexedDB removal finalization transaction recovery", () => {
  it("preserves all records on abort and permits an exact retry after restart", async () => {
    const name = "finalize-removal-abort";
    const { store, factory } = await openStore(name, {
      faultInjector: {
        beforeCommit: (operation, transaction) => {
          if (operation === "finalize-removal-recovery") transaction.abort();
        },
      },
    });
    await store.prepareForward(preparedAttempt());
    await persistTerminal(store);
    const bundle = await loadBundle(store);
    await expect(
      store.finalizeRemovalRecovery(finalizeRequest(bundle)),
    ).resolves.toEqual({ ok: false, code: "recovery-unavailable" });
    await expect(
      store.loadActiveRemoval({ noteIdentity: NOTE }),
    ).resolves.toMatchObject({
      ok: true,
      value: { attempts: [{}], removal: {} },
    });
    await store.dispose();

    const reopened = await openStore(name, {}, factory);
    await expect(
      reopened.store.finalizeRemovalRecovery(finalizeRequest(bundle)),
    ).resolves.toEqual({ ok: true, value: undefined });
    await expect(
      reopened.store.loadActiveRemoval({ noteIdentity: NOTE }),
    ).resolves.toEqual({ ok: true, value: null });
    await reopened.store.dispose();
  });

  it("rejects a bundle that exceeds the reopened note-record quota", async () => {
    const name = "finalize-removal-quota";
    const { store, factory } = await openStore(name);
    await store.prepareForward(preparedAttempt());
    await persistTerminal(store);
    const bundle = await loadBundle(store);
    await store.dispose();
    const constrained = await openStore(
      name,
      { limits: { noteRecords: 1 } },
      factory,
    );
    await expect(
      constrained.store.finalizeRemovalRecovery(finalizeRequest(bundle)),
    ).resolves.toEqual({ ok: false, code: "recovery-limit" });
    await constrained.store.dispose();
  });
});

async function persistTerminal(
  store: RecoveryStore,
  start: RemovalRecordV1 = removal(),
): Promise<RemovalRecordV1> {
  if (start.markerState === "present") {
    const existing = await store.loadActiveRemoval({
      noteIdentity: start.noteIdentity,
    });
    if (existing.ok && existing.value === null) await store.beginRemoval(start);
  }
  const removing = {
    ...start,
    deleteEventAcknowledged: true,
    markerState: "removing" as const,
    trashAcknowledged: true,
  };
  const terminal = { ...removing, markerState: "removed" as const };
  await store.advanceRemoval({ expected: start, replacement: removing });
  await store.advanceRemoval({ expected: removing, replacement: terminal });
  return terminal;
}

async function loadBundle(
  store: RecoveryStore,
): Promise<ActiveRemovalRecoveryV1> {
  const loaded = await store.loadActiveRemoval({ noteIdentity: NOTE });
  if (!loaded.ok || loaded.value === null) {
    throw new Error("Expected active removal recovery.");
  }
  return loaded.value;
}

function finalizeRequest(
  bundle: ActiveRemovalRecoveryV1,
): FinalizeRemovalRecoveryV1 {
  return Object.freeze({
    expectedAttempts: bundle.attempts,
    expectedCheckpoints: bundle.checkpoints,
    expectedRemoval: bundle.removal,
  });
}
