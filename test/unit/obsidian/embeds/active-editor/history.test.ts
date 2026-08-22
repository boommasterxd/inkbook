import { describe, expect, it, vi } from "vitest";

import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";

const model = {
  commitBandOrder: vi.fn(),
  commitElements: vi.fn(),
  commitPage: vi.fn(),
  removeElements: vi.fn(),
  replaceElements: vi.fn(),
};

describe("ActiveEditorHistory applied async transitions", () => {
  it("publishes new Canvas commits for a pane history adapter", () => {
    const history = new ActiveEditorHistory(model);
    const committed = vi.fn();
    const unsubscribe = history.subscribeCommitted(committed);

    history.registerApplied({ payloadBytes: 1, redo: async () => true, undo: async () => true });
    unsubscribe();
    history.registerApplied({ payloadBytes: 1, redo: async () => true, undo: async () => true });

    expect(committed).toHaveBeenCalledOnce();
  });

  it("registers an already applied transition without executing it twice", async () => {
    const history = new ActiveEditorHistory(model);
    const redo = vi.fn(async () => true);
    const undo = vi.fn(async () => true);

    expect(history.registerApplied({ payloadBytes: 10, redo, undo })).toBe(true);
    expect(redo).not.toHaveBeenCalled();
    expect(await history.undoAsync()).toBe(true);
    expect(await history.redoAsync()).toBe(true);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(1);
  });

  it("keeps the cursor unchanged when a stale or cancelled transition returns false", async () => {
    const history = new ActiveEditorHistory(model);
    const undo = vi.fn(async () => false);
    history.registerApplied({ payloadBytes: 1, redo: async () => true, undo });

    expect(await history.undoAsync()).toBe(false);
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("serializes overlapping traversal requests", async () => {
    const history = new ActiveEditorHistory(model);
    const order: string[] = [];
    let releaseFirst = (): void => undefined;
    let signalStarted = (): void => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    history.registerApplied({
      payloadBytes: 1,
      redo: async () => true,
      undo: async () => {
        order.push("oldest");
        return true;
      },
    });
    history.registerApplied({
      payloadBytes: 1,
      redo: async () => true,
      undo: async () => {
        order.push("newest-start");
        signalStarted();
        await firstGate;
        order.push("newest-end");
        return true;
      },
    });

    const newest = history.undoAsync();
    const oldest = history.undoAsync();
    await started;
    expect(order).toEqual(["newest-start"]);
    releaseFirst();

    await expect(Promise.all([newest, oldest])).resolves.toEqual([true, true]);
    expect(order).toEqual(["newest-start", "newest-end", "oldest"]);
    expect(history.canUndo).toBe(false);
  });
});
