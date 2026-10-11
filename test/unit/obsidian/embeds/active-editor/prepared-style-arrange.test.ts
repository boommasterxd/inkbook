import { describe, expect, it, vi } from "vitest";

import type { ArrangeAction } from "../../../../../src/domain/commands/arrange";
import type { InkElementV1, TableElementV1 } from "../../../../../src/domain/schema/public";
import { ElementStore } from "../../../../../src/domain/store/public";
import { ActiveDocumentHistory } from "../../../../../src/obsidian/embeds/active-editor/document-history";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import { PreparedElementHistory } from "../../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import type { EditableDocumentModel } from "../../../../../src/obsidian/embeds/document-model-port";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { elementMutationPorts } from "../../../../fixtures/obsidian/element-mutation-ports";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { axisConnectedLine, coordinateSystem, rectangle } from "../../../domain/store/fixtures";

function documentFixture(elements: readonly InkElementV1[]) {
  const store = new ElementStore(elements);
  let revision = 0;
  let leaseDepth = 0;
  const release = vi.fn(() => {
    leaseDepth -= 1;
  });
  const beginInteractiveOperation = vi.fn(() => {
    leaseDepth += 1;
    return release;
  });
  const model = {
    get revision() {
      return revision;
    },
    beginInteractiveOperation,
    store,
    ...elementMutationPorts(store, () => {
      revision += 1;
    }),
  } as unknown as EditableDocumentModel;
  const history = new ActiveEditorHistory(model);
  const pending: boolean[] = [];
  const reads = vi.spyOn(store, "get");
  reads.mockImplementation((...args) => {
    expect(leaseDepth).toBeGreaterThan(0);
    return ElementStore.prototype.get.apply(store, args);
  });
  vi.spyOn(store, "beginOrder").mockImplementation((...args) => {
    expect(leaseDepth).toBeGreaterThan(0);
    return ElementStore.prototype.beginOrder.apply(store, args);
  });
  return {
    beginInteractiveOperation,
    history,
    model,
    pending,
    reads,
    release,
    store,
    advanceRevision: () => {
      revision += 1;
    },
    inspect: (id: string) => ElementStore.prototype.get.call(store, id)?.element,
  };
}

function styleFixture(elements: readonly InkElementV1[], yielded = false) {
  const fixture = documentFixture(elements);
  let attached = true;
  let current = true;
  let resume = () => undefined as void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let yielding = yielded;
  const scheduler = {
    ...immediateWorkScheduler(() => yielding),
    checkpoint: vi.fn(() => {
      if (!yielding) return undefined;
      return gate.then(() => {
        yielding = false;
      });
    }),
  };
  const prepared = new PreparedElementHistory({
    history: fixture.history,
    isAttached: () => attached,
    model: fixture.model,
    motion: { beginPreviewCommit: () => ({ arm: () => true, cancel: () => undefined }) },
    onPendingChanged: (value) => fixture.pending.push(value),
    workScheduler: scheduler,
  });
  const completed = vi.fn();
  const start = (controlId = "opacity", value: number | string = 0.5, ids = [elements[0]!.id]) =>
    prepared.commitStyle({
      controlId,
      value,
      selection: new Set(ids),
      isCurrent: () => current,
      onCompleted: completed,
    });
  return {
    ...fixture,
    completed,
    prepared,
    resume,
    scheduler,
    start,
    detach: () => {
      attached = false;
    },
    invalidateSelection: () => {
      current = false;
    },
  };
}

async function finished(fixture: ReturnType<typeof styleFixture>) {
  await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledOnce());
  expect(fixture.pending).toEqual([true, false]);
}

describe("prepared style document history", () => {
  it("restores a removed axis and its external connection exactly on Undo", async () => {
    const target = coordinateSystem();
    const dependent = axisConnectedLine();
    const fixture = styleFixture([target, dependent]);
    const deltas = vi.fn();
    fixture.store.subscribe(deltas);

    expect(fixture.start("coordinate-dimension", "2d")).toBe(true);
    expect(fixture.pending).toEqual([true]);
    await finished(fixture);
    expect(fixture.completed).toHaveBeenCalledWith(true);
    expect(fixture.inspect(target.id)).toMatchObject({
      dimension: "2d",
      axes: target.axes.slice(0, 2),
    });
    expect(fixture.inspect(dependent.id)).toMatchObject({
      start: dependent.start,
      startConnection: null,
    });
    expect(deltas).toHaveBeenCalledOnce();
    expect(fixture.history.commandCount).toBe(1);

    await expect(fixture.history.undoAsync()).resolves.toBe(true);
    expect(fixture.inspect(target.id)).toEqual(target);
    expect(fixture.inspect(dependent.id)).toEqual(dependent);
    await expect(fixture.history.redoAsync()).resolves.toBe(true);
    expect(fixture.inspect(dependent.id)).toMatchObject({ startConnection: null });
    expect(deltas).toHaveBeenCalledTimes(3);
  });

  it("commits table dimensions and restores its complete prior structure", async () => {
    const box = rectangle();
    const table: TableElementV1 = {
      columnWidth: 100,
      columns: 2,
      columnOffsets: [120],
      headerHeight: 30,
      createdAt: box.createdAt,
      height: box.height,
      id: box.id,
      kind: "table",
      pivot: box.pivot,
      rotation: box.rotation,
      style: {
        outlineColor: box.style.outlineColor,
        outlineOpacity: box.style.outlineOpacity,
        outlineStyle: box.style.outlineStyle,
        outlineWidth: box.style.outlineWidth,
      },
      x: box.x,
      y: box.y,
    };
    const fixture = styleFixture([table]);

    expect(fixture.start("table-columns", 4)).toBe(true);
    await finished(fixture);
    expect(fixture.completed).toHaveBeenCalledWith(true);
    expect(fixture.inspect(table.id)).toMatchObject({ columns: 4, columnWidth: 100 });
    await expect(fixture.history.undoAsync()).resolves.toBe(true);
    expect(fixture.inspect(table.id)).toEqual(table);
  });
});

it("rejects a style preparation overtaken by history traversal before any publication", async () => {
  const fixture = styleFixture([indexedStroke(0)], true);
  let finishUndo = () => undefined as void;
  const undoGate = new Promise<void>((resolve) => {
    finishUndo = resolve;
  });
  fixture.history.registerApplied({
    payloadBytes: 1,
    redo: () => Promise.resolve(true),
    undo: async () => {
      await undoGate;
      return true;
    },
  });
  const publications = vi.fn();
  fixture.store.subscribe(publications);
  expect(fixture.start()).toBe(true);
  const undo = fixture.history.undoAsync();
  expect(fixture.history.isTraversing).toBe(true);
  fixture.resume();
  await finished(fixture);
  expect(fixture.completed).toHaveBeenCalledWith(false);
  expect(publications).not.toHaveBeenCalled();
  expect(fixture.history.commandCount).toBe(1);
  finishUndo();
  await expect(undo).resolves.toBe(true);
  expect(fixture.release).toHaveBeenCalledTimes(2);
});

describe("prepared style cancellation and failure", () => {
  it.each(["selection", "revision", "detach", "cancel", "dispose"] as const)(
    "rejects %s invalidation at a scheduler yield without publishing",
    async (reason) => {
      const stroke = indexedStroke(0);
      const fixture = styleFixture([stroke], true);
      const commit = vi.spyOn(fixture.model, "commitPreparedElementMutation");
      expect(fixture.start()).toBe(true);
      expect(fixture.start()).toBe(false);
      expect(fixture.scheduler.checkpoint).toHaveBeenCalledOnce();
      expect(fixture.reads).not.toHaveBeenCalled();
      if (reason === "selection") fixture.invalidateSelection();
      if (reason === "revision") fixture.advanceRevision();
      if (reason === "detach") fixture.detach();
      if (reason === "cancel") fixture.prepared.cancel();
      if (reason === "dispose") fixture.prepared.dispose();
      if (reason === "cancel" || reason === "dispose") {
        expect(fixture.start()).toBe(false);
        expect(fixture.release).not.toHaveBeenCalled();
        expect(fixture.pending).toEqual(reason === "cancel" ? [true] : [true, false]);
      }
      fixture.resume();
      await finished(fixture);
      expect(fixture.inspect(stroke.id)).toEqual(stroke);
      expect(commit).not.toHaveBeenCalled();
      expect(fixture.history.commandCount).toBe(0);
      if (reason === "cancel" || reason === "dispose") {
        expect(fixture.completed).not.toHaveBeenCalled();
      } else expect(fixture.completed).toHaveBeenCalledWith(false);
    },
  );

  it.each(["noop", "missing", "invalid", "failure"] as const)(
    "releases its lease and pending state for a %s style result",
    async (reason) => {
      const stroke = indexedStroke(0);
      const fixture = styleFixture([stroke]);
      if (reason === "failure") {
        vi.spyOn(fixture.model, "prepareElementMutation").mockRejectedValue(new Error("failed"));
      }
      const value = reason === "noop" ? 1 : 0.5;
      const ids = reason === "missing" ? ["missing"] : [stroke.id];
      expect(fixture.start(reason === "invalid" ? "unknown" : "opacity", value, ids)).toBe(true);
      await finished(fixture);
      expect(fixture.completed).toHaveBeenCalledWith(false);
      expect(fixture.inspect(stroke.id)).toEqual(stroke);
      expect(fixture.history.commandCount).toBe(0);
    },
  );

  it("rejects a completed mutation token when its selection becomes stale", async () => {
    const stroke = indexedStroke(0);
    const fixture = styleFixture([stroke]);
    const original = fixture.model.prepareElementMutation.bind(fixture.model);
    let resume = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const prepare = vi.spyOn(fixture.model, "prepareElementMutation");
    prepare.mockImplementation(async (...args) => {
      const result = await original(...args);
      expect(result.status).toBe("prepared");
      fixture.invalidateSelection();
      await gate;
      return result;
    });
    const commit = vi.spyOn(fixture.model, "commitPreparedElementMutation");

    expect(fixture.start()).toBe(true);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(fixture.pending).toEqual([true]);
    expect(fixture.release).not.toHaveBeenCalled();
    resume();
    await finished(fixture);
    expect(fixture.completed).toHaveBeenCalledWith(false);
    expect(commit).not.toHaveBeenCalled();
    expect(fixture.inspect(stroke.id)).toEqual(stroke);
    expect(fixture.history.commandCount).toBe(0);
  });
});

function arrangeFixture() {
  const content = Array.from({ length: 5 }, (_, index) => indexedStroke(index));
  const highlight = Array.from({ length: 5 }, (_, index) => ({
    ...indexedStroke(index + 5),
    tool: "highlighter" as const,
    style: { ...indexedStroke(index + 5).style, pressureEnabled: false, width: 8 as const },
  }));
  const fixture = documentFixture([...highlight, ...content]);
  const documentHistory = new ActiveDocumentHistory({
    history: fixture.history,
    model: fixture.model,
    onPendingChanged: (value) => fixture.pending.push(value),
  });
  return {
    ...fixture,
    content,
    documentHistory,
    highlight,
    selection: new Set([content[1]!.id, content[3]!.id, highlight[1]!.id, highlight[3]!.id]),
  };
}

function expectOrder(fixture: ReturnType<typeof arrangeFixture>, indices: readonly number[]) {
  for (const elements of [fixture.highlight, fixture.content]) {
    for (let index = 0; index < indices.length; index += 1) {
      expect(fixture.store.getRank(elements[indices[index]!]!.id)?.rank).toBe(index);
    }
  }
}

describe("prepared arrangement history", () => {
  it.each<[ArrangeAction, number[]]>([
    ["bring-forward", [0, 2, 1, 4, 3]],
    ["send-backward", [1, 0, 3, 2, 4]],
    ["bring-to-front", [0, 2, 4, 1, 3]],
    ["send-to-back", [1, 3, 0, 2, 4]],
  ])("applies %s in both bands with exact Undo and Redo", async (action, indices) => {
    const fixture = arrangeFixture();
    const deltas = vi.fn();
    fixture.store.subscribe(deltas);
    const prepare = vi.spyOn(fixture.model, "prepareElementMutation");
    await expect(
      fixture.documentHistory.arrange(
        action,
        fixture.selection,
        immediateWorkScheduler(),
        () => true,
      ),
    ).resolves.toBe("applied");
    expectOrder(fixture, indices);
    expect(fixture.pending).toEqual([true, false]);
    expect(fixture.release).toHaveBeenCalledOnce();
    expect(fixture.history.commandCount).toBe(1);
    await expect(fixture.history.undoAsync()).resolves.toBe(true);
    expectOrder(fixture, [0, 1, 2, 3, 4]);
    await expect(fixture.history.redoAsync()).resolves.toBe(true);
    expectOrder(fixture, indices);
    expect(prepare.mock.calls[1]![1].replay).toBeDefined();
    expect(prepare.mock.calls[2]![1].replay).toBe(prepare.mock.calls[1]![1].replay);
    expect(deltas).toHaveBeenCalledTimes(3);
  });

  it.each(["empty", "all", "front", "back"] as const)(
    "avoids mutation and history for a %s no-op",
    async (selectionKind) => {
      const fixture = arrangeFixture();
      const elements = [...fixture.content, ...fixture.highlight];
      const ids =
        selectionKind === "all"
          ? elements.map(({ id }) => id)
          : selectionKind === "empty"
            ? []
            : [fixture.content[selectionKind === "front" ? 4 : 0]!.id];
      const action = selectionKind === "back" ? "send-to-back" : "bring-to-front";
      const prepare = vi.spyOn(fixture.model, "prepareElementMutation");
      await expect(
        fixture.documentHistory.arrange(action, new Set(ids), immediateWorkScheduler(), () => true),
      ).resolves.toBe("noop");
      expect(prepare).not.toHaveBeenCalled();
      expect(fixture.history.commandCount).toBe(0);
      expect(fixture.release).toHaveBeenCalledOnce();
      expectOrder(fixture, [0, 1, 2, 3, 4]);
    },
  );

  it.each(["selection", "revision", "dispose", "failure"] as const)(
    "rejects %s during preparation and releases ownership",
    async (reason) => {
      const fixture = arrangeFixture();
      let current = true;
      let resume = () => undefined as void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const scheduler = { ...immediateWorkScheduler(() => true), checkpoint: () => gate };
      if (reason === "failure") {
        scheduler.checkpoint = () => Promise.reject(new Error("failed checkpoint"));
      }
      const commit = vi.spyOn(fixture.model, "commitPreparedElementMutation");
      const result = fixture.documentHistory.arrange(
        "bring-to-front",
        fixture.selection,
        scheduler,
        () => current,
      );
      expect(fixture.documentHistory.pending).toBe(true);
      await expect(
        fixture.documentHistory.arrange(
          "send-to-back",
          fixture.selection,
          immediateWorkScheduler(),
          () => true,
        ),
      ).resolves.toBe("busy");
      if (reason === "selection") current = false;
      if (reason === "revision") fixture.advanceRevision();
      if (reason === "dispose") fixture.documentHistory.dispose();
      resume();
      await expect(result).resolves.toBe(reason === "failure" ? "failed" : "stale");
      expect(fixture.documentHistory.pending).toBe(false);
      expect(fixture.pending).toEqual([true, false]);
      expect(fixture.release).toHaveBeenCalledOnce();
      expect(commit).not.toHaveBeenCalled();
      expect(fixture.history.commandCount).toBe(0);
      expectOrder(fixture, [0, 1, 2, 3, 4]);
    },
  );
});
