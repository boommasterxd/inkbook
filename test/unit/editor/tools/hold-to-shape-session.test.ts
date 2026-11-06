import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  recognizeStrokeSteps,
  type RecognizedShape,
} from "../../../../src/domain/recognition/stroke-recognition";
import { MAX_STROKE_POINTS } from "../../../../src/domain/schema/public";
import { HoldToShapeSession } from "../../../../src/editor/tools/hold-to-shape-session";
import {
  immediateWorkScheduler,
  pausedWorkScheduler,
} from "../../../fixtures/obsidian/immediate-work-scheduler";

vi.mock("../../../../src/domain/recognition/stroke-recognition", () => ({
  recognizeStrokeSteps: vi.fn(),
}));

const recognized: RecognizedShape = {
  kind: "rectangle",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  pivot: { x: 50, y: 50 },
  rotation: 0,
};

function holdClock() {
  let time = 0;
  let handle = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => time,
    schedule: vi.fn((delay: number, callback: () => void) => {
      pending.set(++handle, { at: time + delay, callback });
      return handle;
    }),
    cancel: vi.fn((id: number) => {
      pending.delete(id);
    }),
    pending,
    advance: (duration: number) => {
      const end = time + duration;
      while (pending.size > 0) {
        const next = [...pending].sort((a, b) => a[1].at - b[1].at)[0]!;
        if (next[1].at > end) break;
        time = next[1].at;
        pending.delete(next[0]);
        next[1].callback();
      }
      time = end;
    },
  };
}

function setup(overrides: Partial<ConstructorParameters<typeof HoldToShapeSession>[0]> = {}) {
  const clock = holdClock();
  const onPreview = vi.fn();
  const readPoints = vi.fn(() => [0, 0, 0.5, 100, 0, 0.5, 100, 100, 0.5]);
  const session = new HoldToShapeSession({
    clock,
    settings: { enabled: true, holdDurationMs: 600, jitterTolerancePx: 4 },
    start: { x: 0, y: 0 },
    scheduler: immediateWorkScheduler(),
    zoom: 1,
    readPoints,
    onPreview,
    isCurrent: () => true,
    ...overrides,
  });
  return { clock, session, readPoints, onPreview };
}

function expectRecognitionAfterFullHold(
  clock: ReturnType<typeof holdClock>,
  session: HoldToShapeSession,
): void {
  expect(session.candidate).toBeNull();
  clock.advance(599);
  expect(session.candidate).toBeNull();
  clock.advance(1);
  expect(session.candidate).toEqual(recognized);
}

function pausedRecognitionScheduler() {
  const control = pausedWorkScheduler();
  return {
    ...control,
    scheduler: {
      ...control.scheduler,
      checkpoint: () =>
        control.scheduler.shouldYield() ? control.scheduler.checkpoint() : undefined,
    },
  };
}

beforeEach(() => {
  vi.mocked(recognizeStrokeSteps).mockReset();
  vi.mocked(recognizeStrokeSteps).mockImplementation(function* () {
    yield;
    return recognized;
  });
});

describe("hold-to-shape recognition session", () => {
  it("calculates during the hold and only publishes at the full monotonic deadline", () => {
    const { clock, session, readPoints, onPreview } = setup();
    session.observe([{ x: 100, y: 0 }]);
    expect(readPoints).not.toHaveBeenCalled();
    clock.advance(100);
    expect(readPoints).toHaveBeenCalledTimes(1);
    expect(session.candidate).toBeNull();
    clock.advance(499);
    expect(onPreview).not.toHaveBeenCalled();
    clock.advance(1);
    expect(session.candidate).toEqual(recognized);
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(recognized);
    const committed = session.candidate;
    session.dispose();
    expect(committed).toEqual(recognized);
    expect(session.candidate).toBeNull();
    expect(onPreview).toHaveBeenLastCalledWith(null);
    expect(clock.pending.size).toBe(0);
  });

  it("uses a fixed screen anchor so jitter neither postpones hold nor accumulates drift", () => {
    const { clock, session, onPreview } = setup({ zoom: 0.1 });
    clock.advance(200);
    session.observe([
      { x: 3, y: 0 },
      { x: 4, y: 0 },
    ]);
    clock.advance(399);
    expect(onPreview).not.toHaveBeenCalled();
    clock.advance(1);
    expect(session.candidate).toEqual(recognized);
    session.observe([{ x: 5, y: 0 }]);
    expectRecognitionAfterFullHold(clock, session);
    session.dispose();
  });

  it("invalidates a recognized preview for an out-and-back burst before frame batching", () => {
    const { clock, session, onPreview } = setup();
    clock.advance(600);
    session.observe([
      { x: 20, y: 0 },
      { x: 0, y: 0 },
    ]);
    expect(onPreview.mock.calls).toEqual([[recognized], [null]]);
    expectRecognitionAfterFullHold(clock, session);
    session.dispose();
  });

  it("keeps pressure-only and empty raw batches within the existing hold", () => {
    const { clock, session } = setup();
    clock.advance(500);
    session.observe([]);
    session.observe([{ x: 0, y: 0 }]);
    clock.advance(100);
    expect(session.candidate).toEqual(recognized);
    session.dispose();
  });

  it("reuses owned timers during continuous input and honors the final quiet deadlines", () => {
    const { clock, session, readPoints } = setup();
    for (let index = 1; index <= 120; index++) {
      clock.advance(2);
      session.observe([{ x: index * 5, y: 0 }]);
      expect(clock.pending.size).toBeLessThanOrEqual(2);
    }
    expect(clock.schedule).toHaveBeenCalledTimes(4);
    expect(clock.cancel).not.toHaveBeenCalled();
    clock.advance(99);
    expect(readPoints).not.toHaveBeenCalled();
    clock.advance(1);
    expect(readPoints).toHaveBeenCalledTimes(1);
    expect(session.candidate).toBeNull();
    clock.advance(499);
    expect(session.candidate).toBeNull();
    clock.advance(1);
    expect(session.candidate).toEqual(recognized);
    expect(clock.schedule).toHaveBeenCalledTimes(6);
    session.dispose();
    expect(clock.pending.size).toBe(0);
  });
});

describe("hold-to-shape cooperative ownership", () => {
  it("cancels an admitted job on movement and never publishes its stale result", async () => {
    const { scheduler, resume } = pausedRecognitionScheduler();
    const { clock, session, readPoints, onPreview } = setup({ scheduler });
    clock.advance(100);
    expect(readPoints).not.toHaveBeenCalled();
    session.observe([{ x: 30, y: 0 }]);
    resume();
    await Promise.resolve();
    expect(readPoints).not.toHaveBeenCalled();
    clock.advance(599);
    expect(onPreview).not.toHaveBeenCalled();
    clock.advance(1);
    expect(session.candidate).toEqual(recognized);
    expect(readPoints).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it.each(["release", "capture-loss", "stale-owner"])(
    "falls back to raw ink when %s occurs while recognition is delayed",
    async (reason) => {
      let current = true;
      const { scheduler, resume } = pausedRecognitionScheduler();
      const { clock, session, onPreview } = setup({ scheduler, isCurrent: () => current });
      clock.advance(600);
      expect(session.candidate).toBeNull();
      if (reason === "stale-owner") current = false;
      else session.dispose();
      resume();
      await Promise.resolve();
      expect(session.candidate).toBeNull();
      expect(onPreview).not.toHaveBeenCalled();
      expect(clock.pending.size).toBe(0);
    },
  );

  it("publishes only after recognition completes when scheduler admission exceeds the hold", async () => {
    const { scheduler, resume } = pausedRecognitionScheduler();
    const { clock, session, onPreview } = setup({ scheduler });
    clock.advance(600);
    expect(onPreview).not.toHaveBeenCalled();
    resume();
    await Promise.resolve();
    expect(session.candidate).toEqual(recognized);
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(recognized);
    session.dispose();
  });

  it("takes one bounded snapshot before cooperative recognition can observe later mutation", async () => {
    const source = Array.from({ length: MAX_STROKE_POINTS * 3 }, (_, index) =>
      index % 3 === 2 ? 0.5 : index,
    );
    const expected = source.slice();
    const copy = vi.spyOn(source, "slice");
    const { scheduler, pause, resume } = pausedRecognitionScheduler();
    resume();
    vi.mocked(recognizeStrokeSteps).mockImplementation(function* (points) {
      pause();
      yield;
      expect(points).toEqual(expected);
      return recognized;
    });
    const { clock, session } = setup({ scheduler, readPoints: () => source });
    clock.advance(100);
    source[0] = 999;
    source.push(200, 200, 0.8);
    clock.advance(500);
    expect(session.candidate).toBeNull();
    resume();
    await Promise.resolve();
    expect(session.candidate).toEqual(recognized);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(recognizeStrokeSteps).toHaveBeenCalledTimes(1);
    session.dispose();
  });
});

describe("hold-to-shape raw fallback", () => {
  it.each(["unsupported", "failed", "oversized"])(
    "retains raw ink for %s recognition without a preview",
    (reason) => {
      vi.mocked(recognizeStrokeSteps).mockImplementation(function* () {
        yield;
        if (reason === "failed") throw new Error("recognition failed");
        return null;
      });
      const { clock, session, onPreview } = setup({
        readPoints: () =>
          reason === "oversized" ? new Array<number>(MAX_STROKE_POINTS * 3 + 3) : [],
      });
      clock.advance(1000);
      expect(session.candidate).toBeNull();
      expect(onPreview).not.toHaveBeenCalled();
      if (reason === "oversized") expect(recognizeStrokeSteps).not.toHaveBeenCalled();
      session.dispose();
    },
  );

  it("handles scheduler shutdown without an unhandled rejection or snapshot read", async () => {
    const scheduler = immediateWorkScheduler();
    scheduler.checkpoint = () => Promise.reject(new Error("scheduler disposed"));
    const { clock, session, readPoints, onPreview } = setup({ scheduler });
    clock.advance(600);
    await Promise.resolve();
    expect(readPoints).not.toHaveBeenCalled();
    expect(session.candidate).toBeNull();
    expect(onPreview).not.toHaveBeenCalled();
    session.dispose();
  });

  it("does no work for disabled recognition and cancels timers on immediate disposal", () => {
    const disabled = setup({
      settings: { enabled: false, holdDurationMs: 600, jitterTolerancePx: 4 },
    });
    disabled.session.observe([{ x: 100, y: 0 }]);
    disabled.clock.advance(1000);
    expect(disabled.clock.pending.size).toBe(0);
    expect(disabled.readPoints).not.toHaveBeenCalled();
    disabled.session.dispose();
    const early = setup();
    early.session.dispose();
    early.session.dispose();
    early.clock.advance(1000);
    expect(early.readPoints).not.toHaveBeenCalled();
    expect(early.clock.pending.size).toBe(0);
  });
});

describe("hold-to-shape publication ownership", () => {
  it("ignores retained timer callbacks after a moving gesture is disposed", () => {
    const { clock, session, readPoints, onPreview } = setup();
    const cancelled = [...clock.pending.values()];
    session.observe([{ x: 30, y: 0 }]);
    session.dispose();
    for (const timer of cancelled) timer.callback();
    expect(readPoints).not.toHaveBeenCalled();
    expect(clock.pending.size).toBe(0);
    clock.advance(600);
    expect(session.candidate).toBeNull();
    expect(onPreview).not.toHaveBeenCalled();
  });

  it("keeps candidate invalid and clears a partially materialized preview when publication fails", () => {
    const onPreview = vi.fn(() => {
      throw new Error("preview failed");
    });
    const { clock, session } = setup({ onPreview });
    expect(() => clock.advance(600)).not.toThrow();
    expect(session.candidate).toBeNull();
    expect(onPreview.mock.calls).toEqual([[recognized], [null]]);
    session.dispose();
  });
});
