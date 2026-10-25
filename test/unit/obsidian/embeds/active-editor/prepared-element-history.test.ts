import { describe, expect, it, vi } from "vitest";

import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import {
  ElementStore,
  type PreparedElementReplacement,
} from "../../../../../src/domain/store/public";
import { PreparedElementHistory } from "../../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import type { EditableDocumentModel } from "../../../../../src/obsidian/embeds/document-session/vault-document-session";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { elementReplacementPorts } from "../../../../fixtures/obsidian/element-mutation-ports";
import { ConnectedSelectionPreviewSession } from "../../../../../src/editor/selection/public";
import { connectionChain } from "../../../../fixtures/domain/connection-chain";
import { rectangle } from "../../../domain/store/fixtures";

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
    const commitPreparedElementReplacement = vi.fn<
      EditableDocumentModel["commitPreparedElementReplacement"]
    >(() => "cancelled");
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
    expect(commitPreparedElementReplacement.mock.calls[0]?.[0]).toBe(PREPARED_TOKEN);
    expect(onCompleted).toHaveBeenCalledWith(false);
  });
});

describe("committed prepared replacement", () => {
  it("cancels a retained replacement replay when its document session shuts down", async () => {
    const target = rectangle();
    const store = new ElementStore([target]);
    let revision = 0;
    const model = {
      get revision() {
        return revision;
      },
      store,
      ...elementReplacementPorts(store, () => {
        revision += 1;
      }),
    } as unknown as EditableDocumentModel;
    const history = new ActiveEditorHistory(model);
    const prepared = new PreparedElementHistory({
      history,
      model,
      isAttached: () => true,
      motion: motionPort(),
      onPendingChanged: vi.fn(),
      workScheduler: immediateWorkScheduler(),
    });
    const completed = vi.fn();
    prepared.commitStyle({
      selection: new Set([target.id]),
      controlId: "opacity",
      value: 0.5,
      isCurrent: () => true,
      onCompleted: completed,
    });
    await vi.waitFor(() => expect(completed).toHaveBeenCalledWith(true));
    prepared.dispose();
    const replacement = store.get(target.id)!.element;
    const prepare = model.prepareElementReplacement.bind(model);
    let finishPreparation = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    const replay = vi
      .spyOn(model, "prepareElementReplacement")
      .mockImplementation(async (...args) => {
        const token = await prepare(...args);
        await gate;
        return token;
      });
    const undo = history.undoAsync();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
    history.dispose();
    finishPreparation();
    await expect(undo).resolves.toBe(false);
    expect(store.get(target.id)?.element).toBe(replacement);
    expect(revision).toBe(1);
  });

  it("registers history after a committed replacement even if disposal follows the commit", async () => {
    const registerApplied = vi.fn(() => true);
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
      history: { registerApplied } as unknown as ActiveEditorHistory,
      isAttached: () => true,
      model,
      motion: motionPort(),
      onPendingChanged: vi.fn(),
      workScheduler: workSchedulerFromFrames(frameWindow()),
    });

    expect(prepared.commitMove(largeSelection(), { x: 1, y: 2 })).toBe(true);
    await vi.waitFor(() => expect(registerApplied).toHaveBeenCalledOnce());
  });
});

it.each(["cancel", "dispose"] as const)(
  "releases retained connection snapshots on prepared history %s without invoking stale UI callbacks",
  async (action) => {
    const elements = connectionChain(300);
    const store = new ElementStore(elements);
    const selected = elements[1]!;
    const connected = new ConnectedSelectionPreviewSession(
      store,
      [selected],
      new Set([selected.id]),
    );
    await connected.prepare(immediateWorkScheduler(), new AbortController().signal);
    const preview = connected.update({ kind: "translate", delta: { x: 30, y: 40 } });
    let resolvePreparation!: (value: { status: "cancelled"; token: null }) => void;
    const gate = new Promise<{ status: "cancelled"; token: null }>((resolve) => {
      resolvePreparation = resolve;
    });
    const prepareElementReplacement = vi.fn(() => gate);
    const model = { store, prepareElementReplacement } as unknown as EditableDocumentModel;
    const prepared = createPreparedHistory(model, motionPort(), () => true, []);
    const onCompleted = vi.fn();
    const onSettled = vi.fn(() => connected.dispose());
    try {
      expect(
        prepared.commitMove([selected], { x: 30, y: 40 }, onCompleted, undefined, null, {
          onSettled,
          requiresPreparation: true,
        }),
      ).toBe(true);
      await vi.waitFor(() => expect(prepareElementReplacement).toHaveBeenCalledOnce());
      expect(preview.progressive!.materialize(elements[299]!.id)).toBeDefined();
      prepared[action]();
      resolvePreparation({ status: "cancelled", token: null });
      await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
      expect(onCompleted).not.toHaveBeenCalled();
      expect(preview.progressive!.materialize(elements[299]!.id)).toBeUndefined();
    } finally {
      prepared.dispose();
      connected.dispose();
    }
  },
);

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
