import { describe, expect, it } from "vitest";

import {
  RESOURCE_BUDGET_V1,
  RESOURCE_CATEGORIES_V1,
  ResourceCoordinatorV1,
  type ResourceBudgetProfileV1,
} from "../../../src/application/resource-coordinator";
import type { ViewId } from "../../../src/application/host-history";
import {
  BoundedHistoryDeliveryQueueV1,
  PhaseZeroHistoryResourceOwnerV1,
} from "../../../src/adapters/obsidian/phase-zero-history-resources";

const ACTION_BYTES = 2_048;
const DESKTOP_SESSION_LIMIT = 16;
const PHONE_SESSION_LIMIT = 8;

describe("Phase-zero history resource profile boundaries", () => {
  it.each([
    [RESOURCE_BUDGET_V1.desktopOrAndroidTablet, DESKTOP_SESSION_LIMIT],
    [RESOURCE_BUDGET_V1.androidPhone, PHONE_SESSION_LIMIT],
  ] as const)(
    "admits exactly the declared session count for $platform",
    (profile, limit) => {
      const coordinator = new ResourceCoordinatorV1(profile);
      const owner = new PhaseZeroHistoryResourceOwnerV1(coordinator);

      for (let index = 0; index < limit; index += 1) {
        expect(owner.admitSession(`note-${String(index)}.md`)).not.toBeNull();
      }
      expect(owner.admitSession("overflow.md")).toBeNull();

      expect(owner.dispose()).toBe(true);
      expect(owner.dispose()).toBe(false);
      expect(coordinator.snapshot().balanced).toBe(true);
      expect(coordinator.snapshot().disposed).toBe(false);
    },
  );
});

describe("Phase-zero history resource ownership", () => {
  it("charges retained records and releases duplicates, branches, detach, and disposal exactly once", async () => {
    const coordinator = new ResourceCoordinatorV1(
      RESOURCE_BUDGET_V1.desktopOrAndroidTablet,
    );
    const owner = new PhaseZeroHistoryResourceOwnerV1(coordinator);
    const editor = "editor-one" as ViewId;
    expect(owner.admitEditorProbe(editor)).toBe(true);
    expect(owner.admitEditorProbe(editor)).toBe(false);
    expect(
      coordinator.snapshot().categories[RESOURCE_CATEGORIES_V1.subscription]
        ?.current.count,
    ).toBe(1);
    expect(
      coordinator.snapshot().categories[RESOURCE_CATEGORIES_V1.attachedView],
    ).toBeUndefined();
    const session = owner.admitSession("note.md");
    if (session === null) throw new Error("Expected admitted history session");

    expect(
      session.reserveAction("effect-one", ACTION_BYTES, ACTION_BYTES),
    ).toBe(true);
    expect(
      session.reserveAction("effect-one", ACTION_BYTES, ACTION_BYTES),
    ).toBe(false);
    expect(session.activateRetention("effect-one")).toBe(true);
    expect(await session.runPreparation("effect-one", async () => true)).toBe(
      true,
    );
    expect(await session.runDelivery("effect-one", async () => undefined)).toBe(
      true,
    );
    expect(session.releaseAction("effect-one")).toBe(true);
    expect(session.releaseAction("effect-one")).toBe(false);
    expect(owner.releaseEditorProbe(editor)).toBe(true);
    expect(owner.releaseEditorProbe(editor)).toBe(false);

    expect(owner.dispose()).toBe(true);
    expect(coordinator.snapshot()).toMatchObject({
      balanced: true,
      disposed: false,
    });
    expect(
      coordinator.snapshot().categories[
        RESOURCE_CATEGORIES_V1.hostHistoryRecord
      ],
    ).toMatchObject({ current: { bytes: 0, count: 0 } });
  });

  it("uses the permanent history emergency slot after ordinary delivery admission is exhausted", async () => {
    const coordinator = new ResourceCoordinatorV1(singleTurnProfile());
    const owner = new PhaseZeroHistoryResourceOwnerV1(coordinator);
    const session = owner.admitSession("note.md");
    if (session === null) throw new Error("Expected admitted history session");
    expect(session.reserveAction("effect", ACTION_BYTES, ACTION_BYTES)).toBe(
      true,
    );
    expect(session.activateRetention("effect")).toBe(true);
    expect(await session.runPreparation("effect", async () => true)).toBe(true);
    expect(await session.runDelivery("effect", async () => undefined)).toBe(
      true,
    );
    const blocker = coordinator.admit({
      bytes: ACTION_BYTES,
      category: RESOURCE_CATEGORIES_V1.sessionTurn,
      count: 1,
      ownerId: "blocker",
      residency: "transient",
      scope: { id: sessionId("note.md"), kind: "session" },
    });
    if (blocker.kind !== "admitted") throw new Error("Expected blocker");
    blocker.handle.activate();
    let completed = false;

    expect(
      await session.runDelivery("effect", async () => {
        completed = true;
      }),
    ).toBe(true);
    expect(completed).toBe(true);
    expect(
      coordinator.snapshot().categories[
        RESOURCE_CATEGORIES_V1.hostHistoryEmergency
      ]?.rejected.count,
    ).toBe(0);

    blocker.handle.release();
    owner.dispose();
    expect(coordinator.snapshot().balanced).toBe(true);
  });
});

describe("Phase-zero history resource rejection", () => {
  it("fails before retaining a history entry when the record budget is exhausted", () => {
    const base = RESOURCE_BUDGET_V1.desktopOrAndroidTablet;
    const coordinator = new ResourceCoordinatorV1({
      ...base,
      categoryLimits: {
        ...base.categoryLimits,
        [RESOURCE_CATEGORIES_V1.hostHistoryRecord]: {
          perScopeBytes: 1,
        },
      },
    });
    const owner = new PhaseZeroHistoryResourceOwnerV1(coordinator);
    const session = owner.admitSession("limited.md");
    if (session === null) throw new Error("Expected admitted history session");

    expect(session.reserveAction("effect", ACTION_BYTES, ACTION_BYTES)).toBe(
      false,
    );
    expect(
      coordinator.snapshot().categories[
        RESOURCE_CATEGORIES_V1.hostHistoryRecord
      ],
    ).toMatchObject({
      current: { bytes: 0, count: 0 },
      reserved: { bytes: 0, count: 0 },
    });
    owner.dispose();
    expect(coordinator.snapshot().balanced).toBe(true);
  });
});

describe("BoundedHistoryDeliveryQueueV1", () => {
  it("bounds pending work without chaining unbounded reservations", async () => {
    const queue = new BoundedHistoryDeliveryQueueV1(1);
    let finishFirst: (() => void) | undefined;
    const order: string[] = [];
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });

    expect(
      queue.enqueue(async () => {
        order.push("first");
        await first;
      }),
    ).toBe(true);
    expect(
      queue.enqueue(async () => {
        order.push("second");
      }),
    ).toBe(true);
    expect(
      queue.enqueue(async () => {
        order.push("overflow");
      }),
    ).toBe(false);
    finishFirst?.();
    await queue.settle();

    expect(order).toEqual(["first", "second"]);
    queue.close();
    expect(queue.enqueue(async () => undefined)).toBe(false);
  });
});

function singleTurnProfile(): ResourceBudgetProfileV1 {
  const base = RESOURCE_BUDGET_V1.desktopOrAndroidTablet;
  return {
    ...base,
    categoryLimits: {
      ...base.categoryLimits,
      [RESOURCE_CATEGORIES_V1.sessionTurn]: {
        bytes: ACTION_BYTES * ACTION_BYTES,
        count: 1,
        perScopeBytes: ACTION_BYTES * ACTION_BYTES,
        perScopeCount: 1,
      },
    },
  };
}

function sessionId(path: string): string {
  return `history-session:${path}`;
}
