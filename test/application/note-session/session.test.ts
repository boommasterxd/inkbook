import { describe, expect, it } from "vitest";

import { parseElementId, parseGroupId } from "../../../src/domain/model";
import type { NoteSessionSnapshotV1 } from "../../../src/application/note-session";
import {
  createTestSession,
  ControlledTimer,
  FakeHistoryAuthority,
  HEADLESS_TIMEOUT_MS,
  NOTE_IDENTITY,
  VIEW_A,
  VIEW_B,
} from "./session-support";

const ID_PAYLOAD = "00000000000000000000000000";
const AFFECTED_ID = parseElementId(`el_${ID_PAYLOAD}`);
const AFFECTED_GROUP_ID = parseGroupId(`grp_${ID_PAYLOAD}`);
const NEXT_EPOCH = 2;

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

describe("note session publication", () => {
  it("publishes immutable snapshots and affected IDs in total turn order", async () => {
    const session = createTestSession();
    const revisions: number[] = [];
    let nested: Promise<unknown> = Promise.resolve();

    session.subscribe((snapshot, affectedIds) => {
      revisions.push(snapshot.scene.revision);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.historyLease)).toBe(true);
      expect(Object.isFrozen(affectedIds)).toBe(true);
      expect(Object.isFrozen(affectedIds.elementIds)).toBe(true);
      expect(Object.isFrozen(affectedIds.groupIds)).toBe(true);
      expect(affectedIds).toEqual({
        elementIds: [AFFECTED_ID],
        groupIds: [AFFECTED_GROUP_ID],
      });
      if (revisions.length === 1) {
        nested = session.enqueue({
          kind: "command",
          retainedBytes: 0,
          run: (): void => undefined,
        });
      }
    });

    await session.enqueue({
      kind: "command",
      retainedBytes: 0,
      run: ({ publish, snapshot }) =>
        publish(snapshot, {
          elementIds: [AFFECTED_ID, AFFECTED_ID],
          groupIds: [AFFECTED_GROUP_ID, AFFECTED_GROUP_ID],
        }),
    });
    await nested;
    expect(revisions).toEqual([0]);
  });
});

describe("note session history and suspension", () => {
  it("derives owner leases from the injected history authority", async () => {
    const history = new FakeHistoryAuthority();
    const session = createTestSession({ history });
    history.own(VIEW_A, 1);

    await session.enqueue({
      kind: "history",
      retainedBytes: 0,
      run: ({ publish, snapshot }) => publish(snapshot),
    });
    expect(session.snapshot.historyLease).toEqual({
      epoch: 1,
      kind: "owned",
      ownerViewId: VIEW_A,
    });

    await session.closeOwner(VIEW_A, true);
    expect(session.snapshot.historyLease).toEqual({ kind: "unowned" });
    history.own(VIEW_B, NEXT_EPOCH);
    await session.enqueue({
      kind: "history",
      retainedBytes: 0,
      run: ({ publish, snapshot }) => publish(snapshot),
    });
    expect(session.snapshot.historyLease).toEqual({
      epoch: NEXT_EPOCH,
      kind: "owned",
      ownerViewId: VIEW_B,
    });
    await session.closeOwner(VIEW_A, true);
    expect(session.snapshot.historyLease).toEqual({
      epoch: NEXT_EPOCH,
      kind: "owned",
      ownerViewId: VIEW_B,
    });
  });

  it("suspends replaceable overlay work while preserving critical turns", async () => {
    const session = createTestSession();
    session.suspendOverlay();

    await expect(
      session.enqueue({
        kind: "view",
        replacement: { key: "projection", revision: 1 },
        retainedBytes: 0,
        run: (): void => undefined,
      }),
    ).resolves.toEqual({ kind: "rejected", reason: "resource-limit" });
    await expect(
      session.enqueue({
        kind: "history",
        retainedBytes: 0,
        run: (): void => undefined,
      }),
    ).resolves.toEqual({ kind: "completed" });
    expect(
      session.readmitOverlay({
        ...NOTE_IDENTITY,
        vaultRelativeMarkdownPath: "notes/other.md",
      }),
    ).toBe(false);
    expect(session.readmitOverlay(NOTE_IDENTITY)).toBe(true);
    await expect(
      session.enqueue({
        kind: "view",
        replacement: { key: "projection", revision: 1 },
        retainedBytes: 0,
        run: (): void => undefined,
      }),
    ).resolves.toEqual({ kind: "completed" });
  });
});

describe("note session headless lifecycle", () => {
  it("completes a bounded headless flush without holding a queue turn", async () => {
    const flush = deferred<"flushed">();
    let ownedDisposals = 0;
    const session = createTestSession({
      disposeOwned: () => {
        ownedDisposals += 1;
      },
      flushHeadless: () => flush.promise,
    });
    const headless = session.beginHeadlessFlush();

    await Promise.resolve();
    await expect(
      session.enqueue({
        kind: "history",
        retainedBytes: 0,
        run: (): void => undefined,
      }),
    ).resolves.toEqual({ kind: "completed" });
    flush.resolve("flushed");
    await expect(headless).resolves.toBe("flushed");
    expect(ownedDisposals).toBe(0);
  });

  it("times out through a controlled timer and aborts the flush", async () => {
    const timer = new ControlledTimer();
    const signal: { current: AbortSignal | null } = { current: null };
    const pending = deferred<"flushed">();
    const session = createTestSession({
      flushHeadless: (request) => {
        signal.current = request.signal;
        return pending.promise;
      },
      timer,
    });
    const headless = session.beginHeadlessFlush();
    await Promise.resolve();

    timer.fireAll();
    await expect(headless).resolves.toBe("timed-out");
    expect(signal.current?.aborted).toBe(true);
    expect(timer.delays).toEqual([HEADLESS_TIMEOUT_MS]);
  });

  it("readmits the same identity and cancels stale headless completion", async () => {
    const pending = deferred<"flushed">();
    const session = createTestSession({ flushHeadless: () => pending.promise });
    const headless = session.beginHeadlessFlush();
    await Promise.resolve();

    expect(session.readmitOverlay(NOTE_IDENTITY)).toBe(true);
    await expect(headless).resolves.toBe("readmitted");
    pending.resolve("flushed");
    await Promise.resolve();
    expect(session.snapshot.lifecycle).toBe("ready");
  });
});

describe("note session disposal", () => {
  it("disposes idempotently and suppresses cancelled publications", async () => {
    const history = new FakeHistoryAuthority();
    const gate = deferred<undefined>();
    const session = createTestSession({ history });
    const publications: NoteSessionSnapshotV1[] = [];
    session.subscribe((snapshot) => publications.push(snapshot));
    const active = session.enqueue({
      kind: "worker",
      retainedBytes: 0,
      run: async ({ publish, signal, snapshot }) => {
        await gate.promise;
        expect(signal.aborted).toBe(true);
        publish(snapshot, {
          elementIds: [AFFECTED_ID],
          groupIds: [],
        });
      },
    });
    await Promise.resolve();

    const first = session.dispose(true);
    const second = session.dispose(true);
    expect(second).toBe(first);
    gate.resolve(undefined);
    await first;
    await expect(active).resolves.toEqual({ kind: "cancelled" });
    expect(session.snapshot.lifecycle).toBe("disposed");
    expect(history.disposeCalls).toBe(1);
    expect(publications.map((snapshot) => snapshot.lifecycle)).toEqual([
      "disposing",
      "disposed",
    ]);
  });

  it("disposes owned resources once after accepted critical work", async () => {
    const order: string[] = [];
    const history = new FakeHistoryAuthority();
    history.onDispose = (): void => {
      order.push("history");
    };
    const session = createTestSession({
      disposeOwned: () => {
        order.push("owned");
      },
      history,
    });
    const critical = session.enqueue({
      kind: "recovery-acknowledgement",
      retainedBytes: 0,
      run: () => {
        order.push("critical");
      },
    });

    const first = session.dispose(false);
    const second = session.dispose(false);
    expect(second).toBe(first);
    await first;
    await critical;
    expect(order).toEqual(["critical", "owned", "history"]);
  });

  it("finishes fail-closed disposal when owned teardown rejects", async () => {
    const history = new FakeHistoryAuthority();
    let ownedCalls = 0;
    const failure = new Error("Owned teardown failed.");
    const session = createTestSession({
      disposeOwned: () => {
        ownedCalls += 1;
        throw failure;
      },
      history,
    });

    const disposal = session.dispose(true);
    await expect(disposal).rejects.toBe(failure);
    expect(session.dispose(true)).toBe(disposal);
    expect(ownedCalls).toBe(1);
    expect(history.disposeCalls).toBe(1);
    expect(session.snapshot.lifecycle).toBe("disposed");
  });
});
