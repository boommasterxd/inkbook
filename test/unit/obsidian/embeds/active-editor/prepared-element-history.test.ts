import { describe, expect, it, vi } from "vitest";

import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import type {
  ElementStore,
  PreparedElementReplacement,
} from "../../../../../src/domain/store/public";
import { PreparedElementHistory } from "../../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import type { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import type { EditableDocumentModel } from "../../../../../src/obsidian/embeds/vault-document-session";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";

const PREPARED_TOKEN = Object.freeze({}) as PreparedElementReplacement;

describe("prepared selection preview lifecycle", () => {
  it("cancels a stale preparation without arming its motion handoff", async () => {
    let attached = true;
    let finishPreparation: (value: {
      readonly status: "prepared";
      readonly token: PreparedElementReplacement;
    }) => void = () => undefined;
    const preparation = new Promise<{
      readonly status: "prepared";
      readonly token: PreparedElementReplacement;
    }>((resolve) => {
      finishPreparation = resolve;
    });
    const prepareElementReplacement = vi.fn(() => preparation);
    const pageBounds = pageBoundsPlanner();
    const model = {
      prepareElementReplacement,
      store: pageBounds.store,
    } as unknown as EditableDocumentModel;
    const motion = motionPort();
    const pending: boolean[] = [];
    const prepared = createPreparedHistory(model, motion, () => attached, pending);

    expect(prepared.commitMove(largeSelection(), { x: 5, y: 8 })).toBe(true);
    await vi.waitFor(() => expect(prepareElementReplacement).toHaveBeenCalledOnce());
    attached = false;
    finishPreparation({ status: "prepared", token: PREPARED_TOKEN });
    await vi.waitFor(() => expect(motion.cancel).toHaveBeenCalledOnce());

    expect(motion.arm).not.toHaveBeenCalled();
    expect(pageBounds.plan).not.toHaveBeenCalled();
    expect(pending).toEqual([true, false]);
  });

  it("keeps a small move synchronous regardless of unchanged sample count", () => {
    const prepareElementReplacement = vi.fn(async () => ({
      status: "cancelled" as const,
      token: null,
    }));
    const pageBounds = pageBoundsPlanner();
    const model = {
      prepareElementReplacement,
      store: pageBounds.store,
    } as unknown as EditableDocumentModel;
    const motion = motionPort();
    const prepared = createPreparedHistory(model, motion, () => true, []);
    const elements = Array.from({ length: 2 }, (_, index) => ({
      ...indexedStroke(index),
      points: Array.from({ length: 9_000 }, () => [20, 20, 0.5]).flat(),
    }));
    expect(prepared.commitMove(elements, { x: 1, y: 1 })).toBe(false);
    expect(motion.cancel).not.toHaveBeenCalled();
    expect(prepareElementReplacement).not.toHaveBeenCalled();
    expect(motion.arm).not.toHaveBeenCalled();
  });

  it("releases an armed handoff when final token adoption is cancelled", async () => {
    const commitPreparedElementReplacement = vi.fn(() => "cancelled" as const);
    const pageBounds = pageBoundsPlanner();
    const model = {
      commitPreparedElementReplacement,
      prepareElementReplacement: vi.fn(async () => ({
        status: "prepared" as const,
        token: PREPARED_TOKEN,
      })),
      store: pageBounds.store,
    } as unknown as EditableDocumentModel;
    const motion = motionPort();
    const prepared = createPreparedHistory(model, motion, () => true, []);
    const onCompleted = vi.fn();

    expect(prepared.commitMove(largeSelection(), { x: 3, y: 4 }, onCompleted)).toBe(true);
    await vi.waitFor(() => expect(motion.cancel).toHaveBeenCalledOnce());

    expect(motion.arm).toHaveBeenCalledOnce();
    expect(motion.arm.mock.calls[0]?.[0]).toHaveLength(1_001);
    expect(pageBounds.plan).not.toHaveBeenCalled();
    expect(commitPreparedElementReplacement).toHaveBeenCalledWith(PREPARED_TOKEN);
    expect(onCompleted).toHaveBeenCalledWith(false);
  });
});

describe("committed prepared replacement", () => {
  it("registers history after a committed replacement even if disposal follows the commit", async () => {
    const registerAppliedReplacement = vi.fn(() => true);
    let prepared: PreparedElementHistory;
    const model = {
      commitPreparedElementReplacement: vi.fn(() => {
        prepared.dispose();
        return "committed" as const;
      }),
      prepareElementReplacement: vi.fn(async () => ({
        status: "prepared" as const,
        token: PREPARED_TOKEN,
      })),
      store: pageBoundsPlanner().store,
    } as unknown as EditableDocumentModel;
    prepared = new PreparedElementHistory({
      history: { registerAppliedReplacement } as unknown as ActiveEditorHistory,
      isAttached: () => true,
      model,
      motion: motionPort(),
      onPendingChanged: vi.fn(),
      workScheduler: workSchedulerFromFrames(frameWindow()),
    });

    expect(prepared.commitMove(largeSelection(), { x: 1, y: 2 })).toBe(true);
    await vi.waitFor(() => expect(registerAppliedReplacement).toHaveBeenCalledOnce());
  });
});

function createPreparedHistory(
  model: EditableDocumentModel,
  motion: ReturnType<typeof motionPort>,
  isAttached: () => boolean,
  pending: boolean[],
): PreparedElementHistory {
  return new PreparedElementHistory({
    history: {} as ActiveEditorHistory,
    isAttached,
    model,
    motion,
    onPendingChanged: (value) => pending.push(value),
    workScheduler: workSchedulerFromFrames(frameWindow()),
  });
}

function frameWindow(): Window {
  let frame = 0;
  return {
    cancelAnimationFrame: vi.fn(),
    performance,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const handle = ++frame;
      queueMicrotask(() => callback(performance.now()));
      return handle;
    },
  } as unknown as Window;
}

function largeSelection() {
  return Array.from({ length: 1_001 }, (_, index) => indexedStroke(index));
}

function pageBoundsPlanner() {
  const plan = vi.fn(async (replacements: readonly InkElementV1[]) => ({
    elements: replacements,
    replacements,
    yields: 0,
  }));
  return {
    plan,
    store: { planReplacementsTimeSliced: plan } as unknown as ElementStore,
  };
}

function motionPort() {
  const arm = vi.fn((_ids: readonly string[]) => true);
  const cancel = vi.fn();
  return {
    arm,
    beginPreviewCommit: vi.fn(() => ({ arm, cancel })),
    cancel,
  };
}
