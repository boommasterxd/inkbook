import { describe, expect, it } from "vitest";

import type { NoteIdentityV1 } from "../../../src/application/note-session";
import type { NoteSessionIdentityRekeyV1 } from "../../../src/application/note-session/registry";
import {
  createTestRegistry,
  FakeHistoryAuthority,
  NOTE_IDENTITY,
  TEST_REGISTRY_RESERVED_TURNS,
  VIEW_A,
  VIEW_B,
} from "./session-support";

const SOURCE_A = NOTE_IDENTITY;
const SOURCE_B: NoteIdentityV1 = Object.freeze({
  ...NOTE_IDENTITY,
  vaultRelativeMarkdownPath: "notes/other.md",
});
const TARGET_A: NoteIdentityV1 = Object.freeze({
  ...NOTE_IDENTITY,
  vaultRelativeMarkdownPath: "archive/source.md",
});
const TARGET_B: NoteIdentityV1 = Object.freeze({
  ...NOTE_IDENTITY,
  vaultRelativeMarkdownPath: "archive/other.md",
});
const EXTRA_SOURCE: NoteIdentityV1 = Object.freeze({
  ...NOTE_IDENTITY,
  vaultRelativeMarkdownPath: "notes/extra.md",
});
const EXTRA_TARGET: NoteIdentityV1 = Object.freeze({
  ...NOTE_IDENTITY,
  vaultRelativeMarkdownPath: "archive/extra.md",
});
const COMMIT_FAILURE_ROLLBACKS = 2;

function batch(): readonly NoteSessionIdentityRekeyV1[] {
  return Object.freeze([
    Object.freeze({ prior: SOURCE_A, replacement: TARGET_A }),
    Object.freeze({ prior: SOURCE_B, replacement: TARGET_B }),
  ]);
}

function historiesByPath(): {
  readonly histories: Map<string, FakeHistoryAuthority>;
  readonly historyFactory: (identity: NoteIdentityV1) => FakeHistoryAuthority;
} {
  const histories = new Map<string, FakeHistoryAuthority>();
  return {
    histories,
    historyFactory: (identity): FakeHistoryAuthority => {
      const history = new FakeHistoryAuthority();
      histories.set(identity.vaultRelativeMarkdownPath, history);
      return history;
    },
  };
}

describe("note session registry batch rekey", () => {
  it("commits every key atomically and preserves existing references", async () => {
    const fixture = historiesByPath();
    const registry = createTestRegistry({
      historyFactory: fixture.historyFactory,
    });
    const first = registry.acquire(SOURCE_A, VIEW_A);
    const second = registry.acquire(SOURCE_B, VIEW_B);
    if (!first.ok || !second.ok) throw new Error("Missing batch sessions.");
    const commitObservations: number[][] = [];
    for (const history of fixture.histories.values()) {
      history.onRekeyCommit = (): void => {
        commitObservations.push([
          registry.referenceCount(SOURCE_A),
          registry.referenceCount(SOURCE_B),
          registry.referenceCount(TARGET_A),
          registry.referenceCount(TARGET_B),
        ]);
      };
    }

    await expect(registry.rekeyBatch(batch())).resolves.toEqual({
      ok: true,
      value: undefined,
    });

    expect(commitObservations).toEqual([
      [1, 1, 0, 0],
      [1, 1, 0, 0],
    ]);
    expect(registry.referenceCount(SOURCE_A)).toBe(0);
    expect(registry.referenceCount(SOURCE_B)).toBe(0);
    expect(registry.referenceCount(TARGET_A)).toBe(1);
    expect(registry.referenceCount(TARGET_B)).toBe(1);
    await first.value.release();
    await second.value.release();
    expect(registry.sessionCount).toBe(0);
  });

  it.each([
    [
      "duplicate source",
      [
        { prior: SOURCE_A, replacement: TARGET_A },
        { prior: SOURCE_A, replacement: TARGET_B },
      ],
    ],
    [
      "duplicate target",
      [
        { prior: SOURCE_A, replacement: TARGET_A },
        { prior: SOURCE_B, replacement: TARGET_A },
      ],
    ],
    [
      "source-target cross collision",
      [
        { prior: SOURCE_A, replacement: SOURCE_B },
        { prior: SOURCE_B, replacement: TARGET_B },
      ],
    ],
  ] as const)(
    "rejects a %s before preparing history",
    async (_name, rekeys) => {
      const fixture = historiesByPath();
      const registry = createTestRegistry({
        historyFactory: fixture.historyFactory,
      });
      const first = registry.acquire(SOURCE_A, VIEW_A);
      const second = registry.acquire(SOURCE_B, VIEW_B);
      if (!first.ok || !second.ok)
        throw new Error("Missing collision sessions.");

      await expect(registry.rekeyBatch(rekeys)).resolves.toEqual({
        code: "invalid-command",
        ok: false,
      });
      expect(
        [...fixture.histories.values()].map((history) => history.rekeyPrepares),
      ).toEqual([0, 0]);
      expect(registry.referenceCount(SOURCE_A)).toBe(1);
      expect(registry.referenceCount(SOURCE_B)).toBe(1);
      await first.value.release();
      await second.value.release();
    },
  );
});

describe("note session registry batch rekey limits and rollback", () => {
  it("rejects an occupied target and an oversized batch before reservation", async () => {
    const registry = createTestRegistry();
    const first = registry.acquire(SOURCE_A, VIEW_A);
    const second = registry.acquire(SOURCE_B, VIEW_B);
    if (!first.ok || !second.ok) throw new Error("Missing preflight sessions.");

    await expect(
      registry.rekeyBatch([{ prior: SOURCE_A, replacement: SOURCE_B }]),
    ).resolves.toEqual({ code: "relocation-pending", ok: false });
    await expect(
      registry.rekeyBatch([
        ...batch(),
        { prior: EXTRA_SOURCE, replacement: EXTRA_TARGET },
      ]),
    ).resolves.toEqual({ code: "resource-limit", ok: false });
    expect(registry.referenceCount(SOURCE_A)).toBe(1);
    expect(registry.referenceCount(SOURCE_B)).toBe(1);
    await first.value.release();
    await second.value.release();
  });

  it("aborts all admitted turns when global lifecycle capacity cannot fit", async () => {
    const fixture = historiesByPath();
    const registry = createTestRegistry({
      historyFactory: fixture.historyFactory,
      limits: {
        maxQueuedTurns: 1,
        maxSessions: 2,
        reservedCriticalTurns: TEST_REGISTRY_RESERVED_TURNS,
      },
    });
    const first = registry.acquire(SOURCE_A, VIEW_A);
    const second = registry.acquire(SOURCE_B, VIEW_B);
    if (!first.ok || !second.ok) throw new Error("Missing capacity sessions.");

    await expect(registry.rekeyBatch(batch())).resolves.toEqual({
      code: "resource-limit",
      ok: false,
    });
    expect(registry.queuedTurnCount).toBe(0);
    expect(
      [...fixture.histories.values()].map((history) => history.rekeyPrepares),
    ).toEqual([0, 0]);
    expect(registry.referenceCount(SOURCE_A)).toBe(1);
    expect(registry.referenceCount(SOURCE_B)).toBe(1);
    await first.value.release();
    await second.value.release();
  });

  it("rolls back every prepared session when one prepare or commit fails", async () => {
    for (const failure of ["prepare", "commit"] as const) {
      const fixture = historiesByPath();
      const registry = createTestRegistry({
        historyFactory: fixture.historyFactory,
      });
      const first = registry.acquire(SOURCE_A, VIEW_A);
      const second = registry.acquire(SOURCE_B, VIEW_B);
      if (!first.ok || !second.ok)
        throw new Error("Missing rollback sessions.");
      const secondHistory = fixture.histories.get(
        SOURCE_B.vaultRelativeMarkdownPath,
      );
      if (secondHistory === undefined) throw new Error("Missing fake history.");
      if (failure === "prepare") secondHistory.prepareRekeyAllowed = false;
      else secondHistory.failRekeyCommit = true;

      await expect(registry.rekeyBatch(batch())).resolves.toEqual({
        code: "invalid-command",
        ok: false,
      });
      expect(registry.referenceCount(SOURCE_A)).toBe(1);
      expect(registry.referenceCount(SOURCE_B)).toBe(1);
      expect(registry.referenceCount(TARGET_A)).toBe(0);
      expect(registry.referenceCount(TARGET_B)).toBe(0);
      expect(
        [...fixture.histories.values()].reduce(
          (sum, history) => sum + history.rekeyRollbacks,
          0,
        ),
      ).toBe(failure === "prepare" ? 1 : COMMIT_FAILURE_ROLLBACKS);
      await first.value.release();
      await second.value.release();
    }
  });
});
