import { describe, expect, it } from "vitest";

import {
  NoteSessionQueueV1,
  type NoteSessionQueueCapacityV1,
  type NoteSessionQueueTurnV1,
  type NoteSessionTurnKindV1,
} from "../../../src/application/note-session/queue";

const MAX_TURNS = 5;
const MAX_BYTES = 500;
const RESERVED_TURNS = 3;
const RESERVED_BYTES = 300;
const REVISION_TWO = 2;
const EXPECTED_RETAINED_TURNS = 2;

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function turn(
  kind: NoteSessionTurnKindV1,
  run: NoteSessionQueueTurnV1["run"] = (): void => undefined,
  replacement?: { readonly key: string; readonly revision: number },
): NoteSessionQueueTurnV1 {
  return {
    kind,
    retainedBytes: 50,
    ...(replacement === undefined ? {} : { replacement }),
    run,
  };
}

function queue(capacity?: NoteSessionQueueCapacityV1): NoteSessionQueueV1 {
  return new NoteSessionQueueV1({
    ...(capacity === undefined ? {} : { capacity }),
    limits: {
      maxRetainedBytes: MAX_BYTES,
      maxTurns: MAX_TURNS,
      reservedCriticalBytes: RESERVED_BYTES,
      reservedCriticalTurns: RESERVED_TURNS,
    },
  });
}

describe("note session queue", () => {
  it("serializes listener-style reentrant work without recursion", async () => {
    const subject = queue();
    const order: string[] = [];
    let nested: Promise<unknown> = Promise.resolve();

    const first = subject.enqueue(
      turn("command", () => {
        order.push("first-start");
        nested = subject.enqueue(
          turn("command", () => {
            order.push("nested");
          }),
        );
        order.push("first-end");
      }),
    );

    await first;
    await nested;
    expect(order).toEqual(["first-start", "first-end", "nested"]);
    expect(subject.retainedTurns).toBe(0);
  });

  it("preserves reserved lifecycle and history capacity at saturation", async () => {
    const subject = queue();
    const gate = deferred();
    const first = subject.enqueue(turn("command", () => gate.promise));
    const second = subject.enqueue(turn("command"));

    await expect(subject.enqueue(turn("command"))).resolves.toEqual({
      kind: "rejected",
      reason: "resource-limit",
    });
    const history = subject.enqueue(turn("history"));
    const lifecycle = subject.enqueue(turn("lifecycle"));
    const acknowledgement = subject.enqueue(turn("recovery-acknowledgement"));
    expect(subject.retainedTurns).toBe(MAX_TURNS);
    await expect(subject.enqueue(turn("view"))).resolves.toEqual({
      kind: "rejected",
      reason: "resource-limit",
    });

    gate.resolve();
    await expect(
      Promise.all([first, second, history, lifecycle, acknowledgement]),
    ).resolves.toEqual([
      { kind: "completed" },
      { kind: "completed" },
      { kind: "completed" },
      { kind: "completed" },
      { kind: "completed" },
    ]);
  });
});

describe("note session queue replacement and disposal", () => {
  it.each(["view", "worker", "save", "checkpoint"] as const)(
    "replaces only a waiting superseded %s revision",
    async (kind) => {
      const subject = queue();
      const gate = deferred();
      const ran: number[] = [];
      const blocker = subject.enqueue(turn("command", () => gate.promise));
      const stale = subject.enqueue(
        turn(
          kind,
          () => {
            ran.push(1);
          },
          { key: "same-work", revision: 1 },
        ),
      );
      const current = subject.enqueue(
        turn(
          kind,
          () => {
            ran.push(REVISION_TWO);
          },
          {
            key: "same-work",
            revision: REVISION_TWO,
          },
        ),
      );

      await expect(stale).resolves.toEqual({ kind: "replaced" });
      await expect(
        subject.enqueue(
          turn(
            kind,
            () => {
              ran.push(1);
            },
            {
              key: "same-work",
              revision: 1,
            },
          ),
        ),
      ).resolves.toEqual({ kind: "superseded" });
      expect(subject.retainedTurns).toBe(EXPECTED_RETAINED_TURNS);
      gate.resolve();
      await blocker;
      await expect(current).resolves.toEqual({ kind: "completed" });
      expect(ran).toEqual([REVISION_TWO]);
    },
  );

  it.each([
    "command",
    "history",
    "lifecycle",
    "recovery-acknowledgement",
    "persistence",
  ] as const)("never makes protected %s work replaceable", (kind) => {
    const subject = queue();
    expect(() =>
      subject.enqueue(turn(kind, undefined, { key: "protected", revision: 1 })),
    ).toThrow(TypeError);
  });
});

describe("note session queue terminal disposal", () => {
  it("cancels ordinary work but drains accepted critical turns on disposal", async () => {
    let retained = 0;
    const capacity: NoteSessionQueueCapacityV1 = {
      release: () => {
        retained -= 1;
      },
      tryReserve: () => {
        retained += 1;
        return true;
      },
    };
    const subject = queue(capacity);
    const gate = deferred();
    const activeSignal: { current: AbortSignal | null } = { current: null };
    const active = subject.enqueue(
      turn("worker", (signal) => {
        activeSignal.current = signal;
        return gate.promise;
      }),
    );
    const pending = subject.enqueue(
      turn("view", undefined, { key: "projection", revision: 1 }),
    );

    await Promise.resolve();
    expect(subject.cancelPendingReplacement("view", "projection")).toBe(true);
    await expect(pending).resolves.toEqual({ kind: "cancelled" });
    const ordinary = subject.enqueue(
      turn("view", undefined, { key: "latest-projection", revision: 1 }),
    );
    const criticalOrder: string[] = [];
    const history = subject.enqueue(
      turn("history", () => {
        criticalOrder.push("history");
      }),
    );
    const lifecycle = subject.enqueue(
      turn("lifecycle", () => {
        criticalOrder.push("lifecycle");
      }),
    );
    const acknowledgement = subject.enqueue(
      turn("recovery-acknowledgement", () => {
        criticalOrder.push("acknowledgement");
      }),
    );
    const disposal = subject.dispose();
    expect(activeSignal.current?.aborted).toBe(true);
    await expect(ordinary).resolves.toEqual({ kind: "cancelled" });
    await expect(active).resolves.toEqual({ kind: "cancelled" });
    await expect(
      Promise.all([history, lifecycle, acknowledgement]),
    ).resolves.toEqual([
      { kind: "completed" },
      { kind: "completed" },
      { kind: "completed" },
    ]);
    await disposal;
    gate.resolve();
    expect(criticalOrder).toEqual(["history", "lifecycle", "acknowledgement"]);
    expect(retained).toBe(0);
    expect(subject.retainedBytes).toBe(0);
    await expect(subject.enqueue(turn("lifecycle"))).resolves.toEqual({
      kind: "rejected",
      reason: "disposed",
    });
  });
});
