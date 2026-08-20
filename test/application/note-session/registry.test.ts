import { describe, expect, it } from "vitest";

import type { NoteSessionV1 } from "../../../src/application/note-session/session";
import { parseViewId } from "../../../src/application/note-session";
import {
  createTestRegistry,
  FakeHistoryAuthority,
  MAX_TEST_GLOBAL_TURNS,
  NOTE_IDENTITY,
  TEST_REGISTRY_RESERVED_TURNS,
  VIEW_A,
  VIEW_B,
} from "./session-support";

const MAX_GLOBAL_TURNS = MAX_TEST_GLOBAL_TURNS;
const REGISTRY_RESERVED_TURNS = TEST_REGISTRY_RESERVED_TURNS;
const LIFECYCLE_CYCLES = 50;
const EXPECTED_REFERENCES = 2;
const RENAMED_IDENTITY = Object.freeze({
  ...NOTE_IDENTITY,
  vaultRelativeMarkdownPath: "archive/source.md",
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = (): void => undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const createRegistry = createTestRegistry;

describe("note session registry", () => {
  it("returns one reference-counted session per resolved identity", async () => {
    const created: NoteSessionV1[] = [];
    const registry = createRegistry({
      onCreate: (session) => {
        created.push(session);
      },
    });
    const first = registry.acquire(NOTE_IDENTITY, VIEW_A);
    const second = registry.acquire({ ...NOTE_IDENTITY }, VIEW_B);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.session).toBe(second.value.session);
    expect(created).toHaveLength(1);
    expect(registry.referenceCount(NOTE_IDENTITY)).toBe(EXPECTED_REFERENCES);
    await first.value.release();
    expect(registry.referenceCount(NOTE_IDENTITY)).toBe(1);
    await second.value.release();
    expect(registry.sessionCount).toBe(0);
  });

  it("rejects a new identity at the session cap without evicting one", async () => {
    const registry = createRegistry({
      limits: {
        maxQueuedTurns: MAX_GLOBAL_TURNS,
        maxSessions: 1,
        reservedCriticalTurns: REGISTRY_RESERVED_TURNS,
      },
    });
    const first = registry.acquire(NOTE_IDENTITY, VIEW_A);
    expect(first.ok).toBe(true);
    const second = registry.acquire(
      {
        ...NOTE_IDENTITY,
        vaultRelativeMarkdownPath: "notes/other.md",
      },
      VIEW_B,
    );
    expect(second).toEqual({ code: "resource-limit", ok: false });
    expect(registry.sessionCount).toBe(1);
    if (first.ok) await first.value.release();
  });
});

describe("note session registry owner retention", () => {
  it("retains a blocked owner epoch instead of evicting actionable history", async () => {
    const history = new FakeHistoryAuthority();
    history.own(VIEW_A, 1);
    history.closeAllowed = false;
    const registry = createRegistry({ history });
    const reference = registry.acquire(NOTE_IDENTITY, VIEW_A);
    if (!reference.ok) throw new Error("Missing owner reference.");

    await reference.value.release();
    expect(registry.referenceCount(NOTE_IDENTITY)).toBe(0);
    expect(registry.sessionCount).toBe(1);
    expect(reference.value.session.snapshot.historyLease).toEqual({
      kind: "blocked",
      reason: "history-unavailable",
    });
    await registry.dispose(true);
  });
});

describe("note session registry identity rekey", () => {
  it("atomically rekeys one shared two-pane session and preserves releases", async () => {
    const registry = createRegistry();
    const first = registry.acquire(NOTE_IDENTITY, VIEW_A);
    const second = registry.acquire(NOTE_IDENTITY, VIEW_B);
    if (!first.ok || !second.ok) throw new Error("Missing shared session.");

    const rekey = registry.rekey(NOTE_IDENTITY, RENAMED_IDENTITY);
    let observedCounts: readonly number[] = [];
    const followingTurn = first.value.session.enqueue({
      kind: "lifecycle",
      retainedBytes: 0,
      run: () => {
        observedCounts = [
          registry.referenceCount(NOTE_IDENTITY),
          registry.referenceCount(RENAMED_IDENTITY),
        ];
      },
    });

    await expect(rekey).resolves.toEqual({ ok: true, value: undefined });
    await followingTurn;

    expect(registry.referenceCount(NOTE_IDENTITY)).toBe(0);
    expect(registry.referenceCount(RENAMED_IDENTITY)).toBe(EXPECTED_REFERENCES);
    expect(observedCounts).toEqual([0, EXPECTED_REFERENCES]);
    await expect(
      registry.rekey(NOTE_IDENTITY, {
        ...RENAMED_IDENTITY,
        vaultRelativeMarkdownPath: "archive/again.md",
      }),
    ).resolves.toEqual({ code: "invalid-command", ok: false });
    await first.value.release();
    await second.value.release();
    await registry.dispose(false);
  });

  it("rejects target collisions and stale identities without partial changes", async () => {
    const registry = createRegistry();
    const source = registry.acquire(NOTE_IDENTITY, VIEW_A);
    const target = registry.acquire(RENAMED_IDENTITY, VIEW_B);
    if (!source.ok || !target.ok)
      throw new Error("Missing collision fixtures.");

    await expect(
      registry.rekey(NOTE_IDENTITY, RENAMED_IDENTITY),
    ).resolves.toEqual({ code: "relocation-pending", ok: false });
    await expect(
      registry.rekey(
        { ...NOTE_IDENTITY, vaultRelativeMarkdownPath: "missing.md" },
        RENAMED_IDENTITY,
      ),
    ).resolves.toEqual({ code: "invalid-command", ok: false });
    expect(registry.referenceCount(NOTE_IDENTITY)).toBe(1);
    expect(registry.referenceCount(RENAMED_IDENTITY)).toBe(1);

    await source.value.release();
    await target.value.release();
  });

  it("reserves both identities while the lifecycle turn is queued", async () => {
    const gate = deferred<undefined>();
    const registry = createRegistry();
    const reference = registry.acquire(NOTE_IDENTITY, VIEW_A);
    if (!reference.ok) throw new Error("Missing source session.");
    const active = reference.value.session.enqueue({
      kind: "command",
      retainedBytes: 0,
      run: () => gate.promise,
    });
    const rekey = registry.rekey(NOTE_IDENTITY, RENAMED_IDENTITY);

    expect(registry.acquire(NOTE_IDENTITY, VIEW_B)).toEqual({
      code: "relocation-pending",
      ok: false,
    });
    expect(registry.acquire(RENAMED_IDENTITY, VIEW_B)).toEqual({
      code: "relocation-pending",
      ok: false,
    });

    gate.resolve(undefined);
    await active;
    await expect(rekey).resolves.toMatchObject({ ok: true });
    await reference.value.release();
  });

  it("lists only bounded identities under an exact folder prefix", async () => {
    const registry = createRegistry();
    const source = registry.acquire(NOTE_IDENTITY, VIEW_A);
    const unrelated = registry.acquire(RENAMED_IDENTITY, VIEW_B);
    if (!source.ok || !unrelated.ok)
      throw new Error("Missing folder fixtures.");

    expect(registry.identitiesWithinPrefix("notes")).toEqual([NOTE_IDENTITY]);
    expect(registry.identitiesWithinPrefix("note")).toEqual([]);

    await source.value.release();
    await unrelated.value.release();
  });
});

describe("note session registry lifecycle", () => {
  it("enforces the registry turn cap while preserving its critical reserve", async () => {
    const gate = deferred<undefined>();
    const registry = createRegistry();
    const first = registry.acquire(NOTE_IDENTITY, VIEW_A);
    const second = registry.acquire(
      {
        ...NOTE_IDENTITY,
        vaultRelativeMarkdownPath: "notes/other.md",
      },
      VIEW_B,
    );
    if (!first.ok || !second.ok) throw new Error("Missing registry sessions.");
    const active = first.value.session.enqueue({
      kind: "command",
      retainedBytes: 0,
      run: () => gate.promise,
    });
    await Promise.resolve();

    await expect(
      second.value.session.enqueue({
        kind: "command",
        retainedBytes: 0,
        run: (): void => undefined,
      }),
    ).resolves.toEqual({ kind: "rejected", reason: "resource-limit" });
    const history = second.value.session.enqueue({
      kind: "history",
      retainedBytes: 0,
      run: (): void => undefined,
    });
    expect(registry.queuedTurnCount).toBe(MAX_GLOBAL_TURNS);
    gate.resolve(undefined);
    await active;
    await history;
    expect(registry.queuedTurnCount).toBe(0);
    await first.value.release();
    await second.value.release();
  });

  it("readmits the same session during a headless flush", async () => {
    const flushes = [deferred<"flushed">(), deferred<"flushed">()];
    const firstFlushStarted = deferred<undefined>();
    let flushIndex = 0;
    const registry = createRegistry({
      flushHeadless: () => {
        const current = flushes[flushIndex];
        flushIndex += 1;
        if (flushIndex === 1) firstFlushStarted.resolve(undefined);
        if (current === undefined) throw new Error("Unexpected flush.");
        return current.promise;
      },
    });
    const first = registry.acquire(NOTE_IDENTITY, VIEW_A);
    if (!first.ok) throw new Error("Missing first reference.");
    const firstRelease = first.value.release();
    await firstFlushStarted.promise;
    const second = registry.acquire(NOTE_IDENTITY, VIEW_B);
    if (!second.ok) throw new Error("Missing readmitted reference.");

    expect(second.value.session).toBe(first.value.session);
    await firstRelease;
    expect(registry.sessionCount).toBe(1);
    const secondRelease = second.value.release();
    await Promise.resolve();
    flushes[1]?.resolve("flushed");
    await secondRelease;
    expect(registry.sessionCount).toBe(0);
  });
});

describe("note session registry resource disposal", () => {
  it("releases every session and queue owner across 50 lifecycle cycles", async () => {
    let ownedDisposals = 0;
    const registry = createRegistry({
      disposeOwnedFactory: () => (): void => {
        ownedDisposals += 1;
      },
    });
    for (let index = 0; index < LIFECYCLE_CYCLES; index += 1) {
      const reference = registry.acquire(
        NOTE_IDENTITY,
        parseViewId(`view-cycle-${String(index)}`),
      );
      if (!reference.ok) throw new Error("A lifecycle cycle was rejected.");
      await reference.value.release();
      expect(registry.sessionCount).toBe(0);
      expect(registry.queuedTurnCount).toBe(0);
      expect(ownedDisposals).toBe(index + 1);
    }
    await registry.dispose(false);
    expect(registry.sessionCount).toBe(0);
    expect(registry.queuedTurnCount).toBe(0);
    expect(ownedDisposals).toBe(LIFECYCLE_CYCLES);
  });

  it("disposes all retained sessions idempotently", async () => {
    const registry = createRegistry();
    expect(registry.acquire(NOTE_IDENTITY, VIEW_A).ok).toBe(true);
    const first = registry.dispose(true);
    const second = registry.dispose(true);
    expect(second).toBe(first);
    await first;
    expect(registry.sessionCount).toBe(0);
    expect(registry.acquire(NOTE_IDENTITY, VIEW_A)).toEqual({
      code: "disposed",
      ok: false,
    });
  });
});
