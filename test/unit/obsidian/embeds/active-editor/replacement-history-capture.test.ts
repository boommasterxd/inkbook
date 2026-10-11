import { describe, expect, it, vi } from "vitest";

import { DEFAULT_HISTORY_BYTE_LIMIT } from "../../../../../src/domain/commands/history";
import type {
  CoordinateSystemElementV1,
  InkElementV1,
} from "../../../../../src/domain/schema/public";
import {
  ElementStore,
  type ElementReplacementHistoryData,
  type PreparedElementReplacement,
} from "../../../../../src/domain/store/public";
import type { SelectionHandleSession } from "../../../../../src/editor/selection/public";
import {
  ActiveEditorHistory,
  captureElementReplacementHistory,
} from "../../../../../src/obsidian/embeds/active-editor/history";
import { PreparedElementHistory } from "../../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import type { EditableDocumentModel } from "../../../../../src/obsidian/embeds/document-model-port";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import {
  axisConnectedLine,
  connectedLine,
  coordinateSystem,
  rectangle,
} from "../../../domain/store/fixtures";

type Capture = (data: ElementReplacementHistoryData) => void;

function replacementData(payloadBytes = 1_234) {
  const target = rectangle();
  const line = connectedLine(target);
  const replacement = { ...target, width: 300, pivot: { x: 250, y: 150 } };
  const detached = { ...line, startConnection: null };
  return {
    previous: [target],
    replacements: [replacement],
    actual: { previous: [target, line], replacements: [replacement, detached], payloadBytes },
  };
}

function synchronousHistory(data: ElementReplacementHistoryData, supported = true) {
  const replaceElements = vi.fn((_elements: readonly InkElementV1[], capture?: Capture) => {
    if (supported) capture?.(data);
  });
  const model = {
    commitBandOrder: vi.fn(),
    commitElements: vi.fn(),
    commitPage: vi.fn(),
    removeElements: vi.fn(),
    replaceElements,
  };
  const history = new ActiveEditorHistory(model);
  const notification = vi.fn();
  history.subscribeCommitted(notification);
  const effect = { apply: vi.fn(), revert: vi.fn() };
  return { effect, history, notification, replaceElements };
}

describe("replacement capture ownership", () => {
  it("reads only captured arrays and payload after the requested arrays become inaccessible", () => {
    const data = replacementData();
    let poisoned = false;
    const guarded = (elements: readonly InkElementV1[]) =>
      new Proxy(elements, {
        get: (target, key, receiver) => {
          if (poisoned) throw new Error("Raw replacement arrays must not be read after capture.");
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
    const captured = captureElementReplacementHistory(
      guarded(data.previous),
      guarded(data.replacements),
    );
    expect(captured.payloadBytes).toBeGreaterThan(0);
    captured.capture(data.actual);
    poisoned = true;
    expect(captured.previous).toBe(data.actual.previous);
    expect(captured.replacements).toBe(data.actual.replacements);
    expect(captured.payloadBytes).toBe(data.actual.payloadBytes);
  });
});

describe("real replacement history capture", () => {
  it("restores real propagated connection records omitted from the requested selection", () => {
    const target = coordinateSystem();
    const line = axisConnectedLine();
    const store = new ElementStore([target, line]);
    const captured = vi.fn<(data: ElementReplacementHistoryData) => void>();
    const model = {
      commitBandOrder: vi.fn(),
      commitElements: vi.fn(),
      commitPage: vi.fn(),
      removeElements: vi.fn(),
      replaceElements: (elements: readonly InkElementV1[], capture?: Capture) => {
        store.replaceMany(elements, (data) => {
          captured(data);
          capture?.(data);
        });
      },
    };
    const history = new ActiveEditorHistory(model);
    const replacement: CoordinateSystemElementV1 = {
      ...target,
      dimension: "2d",
      axes: [target.axes[0], target.axes[1]],
    };

    expect(history.replace([target], [replacement])).toBe(true);
    expect(captured).toHaveBeenCalledOnce();
    const data = captured.mock.calls[0]![0];
    expect(data.previous.map(({ id }) => id)).toEqual([target.id, line.id]);
    expect(data.replacements.map(({ id }) => id)).toEqual([target.id, line.id]);
    expect(history.retainedPayloadBytes).toBe(data.payloadBytes);
    expect(store.get(line.id)?.element).toMatchObject({ startConnection: null });
    expect(history.undo()).toBe(true);
    expect(store.get(target.id)?.element).toEqual(target);
    expect(store.get(line.id)?.element).toEqual(line);
    expect(history.redo()).toBe(true);
    expect(store.get(target.id)?.element).toEqual(replacement);
    expect(store.get(line.id)?.element).toMatchObject({ startConnection: null });
  });
});

describe("synchronous replacement history capture", () => {
  it("replays the actual committed targets and external connections with the actual payload", () => {
    const data = replacementData();
    const fixture = synchronousHistory(data.actual);
    expect(fixture.history.replace(data.previous, data.replacements, fixture.effect)).toBe(true);
    expect(fixture.replaceElements).toHaveBeenCalledOnce();
    expect(fixture.history.commandCount).toBe(1);
    expect(fixture.history.retainedPayloadBytes).toBe(data.actual.payloadBytes);
    expect(fixture.notification).toHaveBeenCalledOnce();
    expect(fixture.effect.apply).toHaveBeenCalledOnce();

    expect(fixture.history.undo()).toBe(true);
    expect(fixture.replaceElements.mock.calls[1]![0]).toBe(data.actual.previous);
    expect(fixture.effect.revert).toHaveBeenCalledOnce();
    expect(fixture.history.redo()).toBe(true);
    expect(fixture.replaceElements.mock.calls[2]![0]).toBe(data.actual.replacements);
    expect(fixture.effect.apply).toHaveBeenCalledTimes(2);
    expect(fixture.notification).toHaveBeenCalledOnce();
  });

  it("evicts retained commands according to captured payload rather than requested records", () => {
    const data = replacementData(DEFAULT_HISTORY_BYTE_LIMIT / 2 + 1);
    const fixture = synchronousHistory(data.actual);
    fixture.history.replace(data.previous, data.replacements);
    fixture.history.replace(data.previous, data.replacements);
    expect(fixture.history.commandCount).toBe(1);
    expect(fixture.history.retainedPayloadBytes).toBe(data.actual.payloadBytes);
    expect(fixture.history.undo()).toBe(true);
    expect(fixture.history.undo()).toBe(false);
  });

  it("uses requested arrays for an adapter which does not invoke the capture callback", () => {
    const data = replacementData();
    const fixture = synchronousHistory(data.actual, false);
    expect(fixture.history.replace(data.previous, data.replacements)).toBe(true);
    expect(fixture.history.retainedPayloadBytes).toBeGreaterThan(0);
    expect(fixture.history.undo()).toBe(true);
    expect(fixture.replaceElements.mock.calls[1]![0]).toBe(data.previous);
    expect(fixture.history.redo()).toBe(true);
    expect(fixture.replaceElements.mock.calls[2]![0]).toBe(data.replacements);
  });

  it("does not publish history or apply frame effects when the replacement fails", () => {
    const data = replacementData();
    const fixture = synchronousHistory(data.actual);
    fixture.replaceElements.mockImplementation(() => {
      throw new Error("replacement failed");
    });
    expect(() => fixture.history.replace(data.previous, data.replacements, fixture.effect)).toThrow(
      "replacement failed",
    );
    expect(fixture.history.commandCount).toBe(0);
    expect(fixture.notification).not.toHaveBeenCalled();
    expect(fixture.effect.apply).not.toHaveBeenCalled();
  });

  it.each(["empty", "mismatch"] as const)(
    "rejects %s requested arrays before attempting capture",
    (kind) => {
      const data = replacementData();
      const fixture = synchronousHistory(data.actual);
      const previous = kind === "empty" ? [] : data.actual.previous;
      expect(fixture.history.replace(previous, data.replacements, fixture.effect)).toBe(false);
      expect(fixture.replaceElements).not.toHaveBeenCalled();
      expect(fixture.history.commandCount).toBe(0);
      expect(fixture.notification).not.toHaveBeenCalled();
      expect(fixture.effect.apply).not.toHaveBeenCalled();
    },
  );
});

function preparedHistory(data: ReturnType<typeof replacementData>, supported = true) {
  const requests: (readonly InkElementV1[])[] = [];
  const token = Object.freeze({}) as PreparedElementReplacement;
  const release = vi.fn();
  const prepare = vi.fn(async (elements: readonly InkElementV1[]) => {
    requests.push(elements);
    return { status: "prepared" as const, token };
  });
  const commit = vi.fn(
    (_token: PreparedElementReplacement, capture?: Capture): "cancelled" | "committed" | "noop" => {
      if (supported) capture?.(data.actual);
      return "committed";
    },
  );
  const model = {
    revision: 0,
    beginInteractiveOperation: () => release,
    prepareElementReplacement: prepare,
    commitPreparedElementReplacement: commit,
  } as unknown as EditableDocumentModel;
  const history = new ActiveEditorHistory(model);
  const notification = vi.fn();
  history.subscribeCommitted(notification);
  const prepared = new PreparedElementHistory({
    history,
    model,
    isAttached: () => true,
    onPendingChanged: vi.fn(),
    motion: { beginPreviewCommit: () => ({ arm: () => true, cancel: () => undefined }) },
    workScheduler: immediateWorkScheduler(),
  });
  const handle = {
    prepareCommitTimeSliced: async () => ({
      status: "ready" as const,
      previous: data.previous,
      replacements: data.replacements,
    }),
  } as unknown as SelectionHandleSession;
  const effect = { apply: vi.fn(), revert: vi.fn() };
  const completed = vi.fn();
  return {
    commit,
    completed,
    effect,
    handle,
    history,
    notification,
    prepare,
    prepared,
    release,
    requests,
  };
}

describe("prepared replacement history capture", () => {
  it("records captured propagation exactly once and reuses captured arrays for traversal", async () => {
    const data = replacementData();
    const fixture = preparedHistory(data);
    expect(
      fixture.prepared.commitHandle(fixture.handle, fixture.completed, () => fixture.effect),
    ).toBe(true);
    await vi.waitFor(() => expect(fixture.completed).toHaveBeenCalledWith(true));
    expect(fixture.commit).toHaveBeenCalledOnce();
    expect(fixture.history.commandCount).toBe(1);
    expect(fixture.history.retainedPayloadBytes).toBe(data.actual.payloadBytes);
    expect(fixture.notification).toHaveBeenCalledOnce();
    expect(fixture.effect.apply).toHaveBeenCalledOnce();
    await expect(fixture.history.undoAsync()).resolves.toBe(true);
    expect(fixture.requests[1]).toBe(data.actual.previous);
    expect(fixture.effect.revert).toHaveBeenCalledOnce();
    await expect(fixture.history.redoAsync()).resolves.toBe(true);
    expect(fixture.requests[2]).toBe(data.actual.replacements);
    expect(fixture.effect.apply).toHaveBeenCalledTimes(2);
    expect(fixture.notification).toHaveBeenCalledOnce();
  });

  it.each(["cancelled", "noop", "failed"] as const)(
    "does not record or apply a frame effect after a %s commit",
    async (outcome) => {
      const data = replacementData();
      const fixture = preparedHistory(data);
      fixture.commit.mockImplementation((_token, capture) => {
        capture?.(data.actual);
        if (outcome === "failed") throw new Error("commit failed");
        return outcome;
      });
      fixture.prepared.commitHandle(fixture.handle, fixture.completed, () => fixture.effect);
      await vi.waitFor(() => expect(fixture.completed).toHaveBeenCalledWith(false));
      expect(fixture.history.commandCount).toBe(0);
      expect(fixture.notification).not.toHaveBeenCalled();
      expect(fixture.effect.apply).not.toHaveBeenCalled();
      expect(fixture.release).toHaveBeenCalledOnce();
    },
  );

  it("retains requested arrays when a prepared adapter does not support capture", async () => {
    const data = replacementData();
    const fixture = preparedHistory(data, false);
    fixture.prepared.commitHandle(fixture.handle, fixture.completed);
    await vi.waitFor(() => expect(fixture.completed).toHaveBeenCalledWith(true));
    await expect(fixture.history.undoAsync()).resolves.toBe(true);
    expect(fixture.requests[1]).toBe(data.previous);
    await expect(fixture.history.redoAsync()).resolves.toBe(true);
    expect(fixture.requests[2]).toBe(data.replacements);
  });
});
