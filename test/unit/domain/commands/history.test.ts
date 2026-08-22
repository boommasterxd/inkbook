import { describe, expect, it } from "vitest";

import {
  AppliedCommandHistory,
  CommandHistory,
  DEFAULT_HISTORY_BYTE_LIMIT,
  DEFAULT_HISTORY_COMMAND_LIMIT,
  type HistoryCommand,
} from "../../../../src/domain/commands/history";

describe("AppliedCommandHistory synchronous traversal", () => {
  it("supports synchronous toolbar traversal and asynchronous traversal of the same command", async () => {
    const history = new AppliedCommandHistory();
    let value = 1;
    history.registerAppliedSync({
      payloadBytes: 2,
      redo: () => {
        value += 1;
        return true;
      },
      undo: () => {
        value -= 1;
        return true;
      },
    });

    expect(history.undoSync()).toBe(true);
    expect(value).toBe(0);
    expect(history.redoSync()).toBe(true);
    expect(value).toBe(1);
    await expect(history.undo()).resolves.toBe(true);
    expect(value).toBe(0);
    await expect(history.redo()).resolves.toBe(true);
    expect(value).toBe(1);
  });

  it("leaves an asynchronous command for asynchronous traversal", async () => {
    const history = new AppliedCommandHistory();
    history.registerApplied({
      payloadBytes: 1,
      redo: async () => true,
      undo: async () => true,
    });

    expect(history.undoSync()).toBe(false);
    expect(history.canUndo).toBe(true);
    await expect(history.undo()).resolves.toBe(true);
  });
});

describe("AppliedCommandHistory production traversal", () => {
  it("registers an already committed command and serializes asynchronous Undo and Redo", async () => {
    const history = new AppliedCommandHistory();
    const order: string[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    history.registerApplied({
      payloadBytes: 12,
      redo: async () => {
        order.push("redo");
        return true;
      },
      undo: async () => {
        order.push("undo-start");
        await gate;
        order.push("undo-end");
        return true;
      },
    });

    const undo = history.undo();
    const queuedNoOp = history.undo();
    expect(() => history.clear()).toThrow("during an Undo or Redo operation");
    release();

    await expect(Promise.all([undo, queuedNoOp])).resolves.toEqual([true, false]);
    expect(order).toEqual(["undo-start", "undo-end"]);
    expect(history.canRedo).toBe(true);
    await expect(history.redo()).resolves.toBe(true);
    expect(order).toEqual(["undo-start", "undo-end", "redo"]);
    expect(history.retainedBytes).toBe(12);
  });

  it("keeps its cursor stable when traversal is rejected or throws", async () => {
    const rejected = new AppliedCommandHistory();
    rejected.registerApplied({ payloadBytes: 1, redo: async () => true, undo: async () => false });

    await expect(rejected.undo()).resolves.toBe(false);
    expect(rejected.canUndo).toBe(true);
    expect(rejected.canRedo).toBe(false);

    const failed = new AppliedCommandHistory();
    failed.registerApplied({
      payloadBytes: 1,
      redo: async () => true,
      undo: async () => {
        throw new Error("stale operation");
      },
    });
    await expect(failed.undo()).rejects.toThrow("stale operation");
    expect(failed.canUndo).toBe(true);
  });

  it("clears redo on registration and enforces retained payload limits", async () => {
    const history = new AppliedCommandHistory({ maxBytes: 3, maxCommands: 2 });
    const command = (payloadBytes: number) => ({
      payloadBytes,
      redo: async () => true,
      undo: async () => true,
    });
    history.registerApplied(command(2));
    history.registerApplied(command(2));
    expect(history.commandCount).toBe(1);
    await history.undo();
    history.registerApplied(command(1));

    expect(history.canRedo).toBe(false);
    expect(history.commandCount).toBe(1);
    expect(history.retainedBytes).toBe(1);
    expect(() => history.registerApplied(command(-1))).toThrow(RangeError);
  });
});

function addition(amount: number, payloadBytes = 1): HistoryCommand<number> {
  return {
    payloadBytes,
    apply: (state) => state + amount,
    revert: (state) => state - amount,
  };
}

describe("CommandHistory traversal", () => {
  it("supports undo and redo without changing retained payload accounting", () => {
    const history = new CommandHistory<number>();
    const executed = history.execute(0, addition(4, 12));
    const undone = history.undo(executed.state);
    const redone = history.redo(undone.state);

    expect(executed).toEqual({ state: 4, changed: true });
    expect(undone).toEqual({ state: 0, changed: true });
    expect(redone).toEqual({ state: 4, changed: true });
    expect(history.retainedBytes).toBe(12);
  });

  it("does not record no-ops or clear redo for them", () => {
    const history = new CommandHistory<object>();
    const original = {};
    const changed = history.execute(original, {
      payloadBytes: 1,
      apply: () => ({ changed: true }),
      revert: () => original,
    });
    const undone = history.undo(changed.state);
    const noOp = history.execute(undone.state, {
      payloadBytes: 9,
      apply: (state) => state,
      revert: (state) => state,
    });

    expect(noOp).toEqual({ state: original, changed: false });
    expect(history.commandCount).toBe(1);
    expect(history.retainedBytes).toBe(1);
    expect(history.canRedo).toBe(true);
  });

  it("clears redo when a new command is committed", () => {
    const history = new CommandHistory<number>();
    const first = history.execute(0, addition(1, 2));
    const second = history.execute(first.state, addition(2, 3));
    const undone = history.undo(second.state);

    const replacement = history.execute(undone.state, addition(10, 5));

    expect(replacement.state).toBe(11);
    expect(history.canRedo).toBe(false);
    expect(history.commandCount).toBe(2);
    expect(history.retainedBytes).toBe(7);
  });

  it("clears all retained commands", () => {
    const history = new CommandHistory<number>();
    history.execute(0, addition(1));

    history.clear();

    expect(history.commandCount).toBe(0);
    expect(history.retainedBytes).toBe(0);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });
});

describe("CommandHistory limits", () => {
  it("retains at most the newest 200 commands by default", () => {
    const history = new CommandHistory<number>();
    let state = 0;
    for (let index = 0; index <= DEFAULT_HISTORY_COMMAND_LIMIT; index += 1) {
      state = history.execute(state, addition(1)).state;
    }

    expect(state).toBe(201);
    expect(history.commandCount).toBe(DEFAULT_HISTORY_COMMAND_LIMIT);
    for (let index = 0; index < DEFAULT_HISTORY_COMMAND_LIMIT; index += 1) {
      state = history.undo(state).state;
    }
    expect(state).toBe(1);
    expect(history.undo(state)).toEqual({ state: 1, changed: false });
  });

  it("retains at most 64 MiB and discards the oldest payload first", () => {
    const history = new CommandHistory<number>();
    const halfLimit = DEFAULT_HISTORY_BYTE_LIMIT / 2;
    let state = history.execute(0, addition(1, halfLimit)).state;
    state = history.execute(state, addition(2, halfLimit)).state;
    state = history.execute(state, addition(4, 1)).state;

    expect(history.commandCount).toBe(2);
    expect(history.retainedBytes).toBe(halfLimit + 1);
    state = history.undo(state).state;
    state = history.undo(state).state;
    expect(state).toBe(1);
  });

  it("applies an oversized command but does not retain it", () => {
    const history = new CommandHistory<number>();

    const result = history.execute(0, addition(3, DEFAULT_HISTORY_BYTE_LIMIT + 1));

    expect(result).toEqual({ state: 3, changed: true });
    expect(history.commandCount).toBe(0);
    expect(history.canUndo).toBe(false);
  });

  it("supports explicit zero limits and validates byte counts", () => {
    const history = new CommandHistory<number>({ maxCommands: 0, maxBytes: 0 });

    expect(history.execute(0, addition(1, 0)).state).toBe(1);
    expect(history.commandCount).toBe(0);
    expect(() => history.execute(1, addition(1, -1))).toThrow(RangeError);
    expect(() => new CommandHistory({ maxCommands: 1.5 })).toThrow(RangeError);
  });
});
