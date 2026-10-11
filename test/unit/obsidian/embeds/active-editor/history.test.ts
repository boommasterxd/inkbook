import { describe, expect, it, vi } from "vitest";

import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import { rectangle } from "../../../domain/store/fixtures";

const model = {
  commitBandOrder: vi.fn(),
  commitElements: vi.fn(),
  commitPage: vi.fn(),
  removeElements: vi.fn(),
  replaceElements: vi.fn(),
};

describe("history replay origin", () => {
  it.each(["sync", "async"] as const)(
    "marks only executed %s replay callbacks and preserves traversal availability",
    async (mode) => {
      const observed: boolean[] = [];
      const observe = () => observed.push(history.isReplaying);
      const history = new ActiveEditorHistory({
        ...model,
        commitElements: observe,
        removeElements: observe,
      });
      expect(history.create([rectangle()])).toBe(true);
      expect(observed).toEqual([false]);
      if (mode === "sync") {
        expect(history.undo()).toBe(true);
        expect(history.redo()).toBe(true);
      } else {
        const pending = history.undoAsync();
        expect(history.isTraversing).toBe(true);
        expect(history.isReplaying).toBe(false);
        await expect(pending).resolves.toBe(true);
        await expect(history.redoAsync()).resolves.toBe(true);
      }
      expect(observed).toEqual([false, true, true]);
      expect(history.isReplaying).toBe(false);
      expect(history.isTraversing).toBe(false);
    },
  );

  it("clears replay origin when a synchronous mutation throws", () => {
    const history = new ActiveEditorHistory({
      ...model,
      removeElements: () => {
        expect(history.isReplaying).toBe(true);
        throw new Error("failed replay");
      },
    });
    history.create([rectangle()]);
    expect(() => history.undo()).toThrow("failed replay");
    expect(history.isReplaying).toBe(false);
    expect(history.canUndo).toBe(true);
  });

  it.each([true, false, "throw", "reject"] as const)(
    "scopes async replay and effects through completion %s",
    async (result) => {
      const effects: boolean[] = [];
      const effect = () => effects.push(history.isReplaying);
      const history = new ActiveEditorHistory(model);
      const transition = () => {
        expect(history.isReplaying).toBe(true);
        if (result === "throw") throw new Error("failed replay");
        return Promise.resolve().then(() => {
          expect(history.isReplaying).toBe(true);
          if (result === "reject") throw new Error("failed replay");
          return result;
        });
      };
      history.registerApplied(
        { payloadBytes: 1, redo: transition, undo: transition },
        { apply: effect, revert: effect },
      );
      expect(effects).toEqual([false]);
      const replay = history.undoAsync();
      expect(history.isReplaying).toBe(false);
      if (typeof result === "string") await expect(replay).rejects.toThrow("failed replay");
      else await expect(replay).resolves.toBe(result);
      expect(history.isReplaying).toBe(false);
      expect(effects).toEqual(result === true ? [false, true] : [false]);
      if (result === true) {
        await expect(history.redoAsync()).resolves.toBe(true);
        expect(effects).toEqual([false, true, true]);
        expect(history.isReplaying).toBe(false);
      }
    },
  );
});

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

describe("history interactive priority lifetime", () => {
  it.each([true, false, "throw"] as const)(
    "releases the lease after an Undo result of %s",
    async (result) => {
      let finish: (() => void) | undefined;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const release = vi.fn();
      const beginInteractiveOperation = vi.fn(() => release);
      const history = new ActiveEditorHistory({ ...model, beginInteractiveOperation });
      history.registerApplied({
        payloadBytes: 1,
        redo: async () => true,
        undo: async () => {
          await pending;
          if (result === "throw") throw new Error("failed replay");
          return result;
        },
      });
      const undone = history.undoAsync();
      expect(beginInteractiveOperation).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
      finish?.();
      if (result === "throw") await expect(undone).rejects.toThrow("failed replay");
      else await undone;
      expect(release).toHaveBeenCalledOnce();
      if (result === true) {
        await history.redoAsync();
        expect(beginInteractiveOperation).toHaveBeenCalledTimes(2);
        expect(release).toHaveBeenCalledTimes(2);
      }
    },
  );
});
