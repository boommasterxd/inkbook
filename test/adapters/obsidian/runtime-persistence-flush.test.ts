import { describe, expect, it, vi } from "vitest";

import { flushRuntimePersistenceV1 } from "../../../src/adapters/obsidian/runtime-persistence-flush";
import type {
  NoteSessionTurnResultV1,
  NoteSessionV1,
} from "../../../src/application/note-session";
import type { SavePipelineResultV1 } from "../../../src/application/persistence";

describe("flushRuntimePersistenceV1 source admission", () => {
  it("fails before entering the flushing state when the source cannot be forced", async () => {
    const setFlushing = vi.fn();
    const forceSave = vi.fn();

    await expect(
      flushRuntimePersistenceV1({
        forceSave,
        forceSource: async () => false,
        readSave: async () => ({
          kind: "acknowledged",
          clearedLatestDirty: true,
        }),
        session: null,
        setFlushing,
      }),
    ).resolves.toBe("failed");

    expect(setFlushing).not.toHaveBeenCalled();
    expect(forceSave).not.toHaveBeenCalled();
  });

  it("flushes without a session when no save result exists", async () => {
    const events: string[] = [];
    const result = await flushRuntimePersistenceV1({
      forceSave: () => events.push("save"),
      forceSource: async () => {
        events.push("source");
        return true;
      },
      readSave: () => null,
      session: null,
      setFlushing: (flushing) => events.push(`flushing:${String(flushing)}`),
    });

    expect(result).toBe("flushed");
    expect(events).toEqual([
      "source",
      "flushing:true",
      "save",
      "flushing:false",
    ]);
  });
});

describe("flushRuntimePersistenceV1 save outcomes", () => {
  it.each([
    { kind: "failed" as const, error: new Error("save failed") },
    { kind: "rejected" as const, reason: "resource-limit" as const },
  ])("stops when the persistence turn is $kind", async (queued) => {
    const forceSave = vi.fn();
    const session = {
      enqueue: async (turn: {
        readonly run: () => void;
      }): Promise<NoteSessionTurnResultV1> => {
        turn.run();
        return queued;
      },
    } as unknown as NoteSessionV1;

    await expect(
      flushRuntimePersistenceV1({
        forceSave,
        forceSource: async () => true,
        readSave: async () => ({
          kind: "acknowledged",
          clearedLatestDirty: true,
        }),
        session,
        setFlushing: vi.fn(),
      }),
    ).resolves.toBe("failed");

    expect(forceSave).not.toHaveBeenCalled();
  });

  it("returns the save acknowledgement and always clears flushing", async () => {
    const states: boolean[] = [];
    const session = {
      enqueue: async (turn: {
        readonly run: () => void;
      }): Promise<NoteSessionTurnResultV1> => {
        turn.run();
        return { kind: "completed" };
      },
    } as unknown as NoteSessionV1;
    const save: SavePipelineResultV1 = {
      kind: "acknowledged",
      clearedLatestDirty: false,
    };

    await expect(
      flushRuntimePersistenceV1({
        forceSave: vi.fn(),
        forceSource: async () => true,
        readSave: async () => save,
        session,
        setFlushing: (flushing) => states.push(flushing),
      }),
    ).resolves.toBe("flushed");

    expect(states).toEqual([true, false]);
  });

  it("reports a failed save result while still resetting the state", async () => {
    const states: boolean[] = [];
    const session = {
      enqueue: async (turn: {
        readonly run: () => void;
      }): Promise<NoteSessionTurnResultV1> => {
        turn.run();
        return { kind: "cancelled" };
      },
    } as unknown as NoteSessionV1;

    await expect(
      flushRuntimePersistenceV1({
        forceSave: vi.fn(),
        forceSource: async () => true,
        readSave: async () => ({ kind: "failed" }),
        session,
        setFlushing: (flushing) => states.push(flushing),
      }),
    ).resolves.toBe("failed");

    expect(states).toEqual([true, false]);
  });
});
