/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact scheduler boundaries are the tested contract. */
import { describe, expect, it } from "vitest";

import {
  SAVE_IDLE_DEBOUNCE_MS_V1,
  SAVE_MAX_DIRTY_MS_V1,
  SaveStartScheduler,
  type SaveStartClockV1,
} from "../../../src/application/persistence/save-start-scheduler";
import type { SaveGenerationRequestV1 } from "../../../src/application/persistence/save-pipeline";
import {
  createSaveGeneration,
  createSourceGeneration,
  parseRecoveryAttemptId,
  parseSha256Digest,
  parseSourceCheckpointId,
} from "../../../src/application/note-session";
import { createSceneRevision } from "../../../src/domain/model";

const ID_PAYLOAD = "00000000000000000000000000";

class ControlledClock implements SaveStartClockV1 {
  private now = 0;
  private nextId = 1;
  private readonly tasks = new Map<
    number,
    { readonly at: number; readonly callback: () => void }
  >();

  nowEpochMs(): number {
    return this.now;
  }

  schedule(callback: () => void, delayMs: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { at: this.now + delayMs, callback });
    return id;
  }

  cancel(timer: unknown): void {
    if (typeof timer === "number") this.tasks.delete(timer);
  }

  advance(milliseconds: number): void {
    this.now += milliseconds;
    for (;;) {
      const due = [...this.tasks].sort(
        (left, right) => left[1].at - right[1].at,
      )[0];
      if (due === undefined || due[1].at > this.now) return;
      this.tasks.delete(due[0]);
      due[1].callback();
    }
  }
}

function request(generation: number): SaveGenerationRequestV1<string> {
  const suffix = String(generation).padStart(2, "0");
  return {
    generation: createSaveGeneration(generation),
    coveredAttemptIds: [
      parseRecoveryAttemptId(`ra_${ID_PAYLOAD.slice(0, -2)}${suffix}`),
    ],
    coveredCheckpointIds: [
      parseSourceCheckpointId(`scp_${ID_PAYLOAD.slice(0, -2)}${suffix}`),
    ],
    capture: () => ({
      snapshot: `scene-${suffix}`,
      sceneRevision: createSceneRevision(generation),
      sourceGeneration: createSourceGeneration(generation),
      sourceDigest: parseSha256Digest("a".repeat(64)),
    }),
  };
}

describe("SaveStartScheduler", () => {
  it("starts after exactly 150 ms of idle time", () => {
    const clock = new ControlledClock();
    const starts: SaveGenerationRequestV1<string>[] = [];
    const scheduler = new SaveStartScheduler<string>(clock, (value) => {
      starts.push(value);
    });

    expect(scheduler.markDirty(request(1))).toBe("scheduled");
    clock.advance(SAVE_IDLE_DEBOUNCE_MS_V1 - 1);
    expect(starts).toEqual([]);
    clock.advance(1);
    expect(starts.map((value) => value.generation)).toEqual([
      createSaveGeneration(1),
    ]);
  });

  it("coalesces exact coverage without passing the absolute dirty bound", () => {
    const clock = new ControlledClock();
    const starts: SaveGenerationRequestV1<string>[] = [];
    const scheduler = new SaveStartScheduler<string>(clock, (value) => {
      starts.push(value);
    });

    expect(scheduler.markDirty(request(1))).toBe("scheduled");
    for (let generation = 2; generation <= 20; generation += 1) {
      clock.advance(100);
      expect(scheduler.markDirty(request(generation))).toBe("replaced");
    }
    clock.advance(99);
    expect(starts).toEqual([]);
    clock.advance(1);
    const generations = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(starts[0]?.coveredAttemptIds).toEqual(
      generations.map((value) => request(value).coveredAttemptIds[0]),
    );
    expect(starts[0]?.coveredCheckpointIds).toEqual(
      generations.map((value) => request(value).coveredCheckpointIds[0]),
    );
    expect(starts[0]?.generation).toBe(createSaveGeneration(20));
  });

  it("supports forced flush, cancellation coverage carry, and disposal", () => {
    const clock = new ControlledClock();
    const starts: SaveGenerationRequestV1<string>[] = [];
    const scheduler = new SaveStartScheduler<string>(clock, (value) => {
      starts.push(value);
    });

    scheduler.markDirty(request(1));
    expect(scheduler.cancel(createSaveGeneration(1))).toBe(true);
    expect(scheduler.markDirty(request(1))).toBe("rejected");
    expect(scheduler.markDirty(request(2))).toBe("scheduled");
    expect(scheduler.forceFlush()).toBe(true);
    expect(scheduler.forceFlush()).toBe(false);
    expect(starts[0]?.coveredAttemptIds).toEqual([
      request(1).coveredAttemptIds[0],
      request(2).coveredAttemptIds[0],
    ]);

    scheduler.markDirty(request(3));
    scheduler.dispose();
    scheduler.dispose();
    clock.advance(SAVE_MAX_DIRTY_MS_V1);
    expect(starts).toHaveLength(1);
    expect(scheduler.markDirty(request(4))).toBe("disposed");
  });

  it("retains only the latest dispatched request for an explicit retry", () => {
    const clock = new ControlledClock();
    const starts: SaveGenerationRequestV1<string>[] = [];
    const scheduler = new SaveStartScheduler<string>(clock, (value) => {
      starts.push(value);
    });
    const dirty = request(1);

    scheduler.markDirty(dirty);
    expect(scheduler.forceFlush()).toBe(true);
    expect(scheduler.retainForRetry(dirty)).toBe(true);
    expect(scheduler.retry()).toBe(true);
    expect(scheduler.retry()).toBe(false);
    expect(starts.map((value) => value.generation)).toEqual([
      createSaveGeneration(1),
      createSaveGeneration(1),
    ]);
  });
});
