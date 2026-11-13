import { ChangeSet, type ChangeDesc } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_TEXT_STYLE_RANGES,
  type TextStyleRangeV2,
} from "../../../../../src/domain/schema/public";
import { TextSourceController } from "../../../../../src/obsidian/text/editor/text-source-controller";
import type { TextSourceState } from "../../../../../src/domain/text/text-types";
import { ManualFrameScheduler } from "../../../../fixtures/obsidian/manual-frame-scheduler";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";

function harness(source: string, ranges: TextStyleRangeV2[] = []) {
  const frames = new ManualFrameScheduler();
  const scheduler = workSchedulerFromFrames({
    requestAnimationFrame: frames.requestFrame.bind(frames),
    cancelAnimationFrame: frames.cancelFrame.bind(frames),
  });
  const onChange = vi.fn<(state: TextSourceState, changes?: ChangeDesc) => void>();
  const onError = vi.fn();
  const onPending = vi.fn();
  const controller = new TextSourceController({ source, ranges, paragraphs: [] }, scheduler, {
    onChange,
    onError,
    onPending,
  });
  return { controller, frames, scheduler, onChange, onError, onPending };
}

describe("native source transaction work", () => {
  it("accepts actual non-whitespace typing without treating automatic format markers as user text", () => {
    const { controller } = harness("");
    controller.record(ChangeSet.of({ from: 0, insert: "**" }, 0), {}, true, false);
    expect(controller.hasMeaningfulUserInput).toBe(false);
    controller.record(ChangeSet.of({ from: 2, insert: " \n" }, 2), {});
    expect(controller.hasMeaningfulUserInput).toBe(false);
    controller.record(ChangeSet.of({ from: 4, insert: "$" }, 4), {});
    expect(controller.hasMeaningfulUserInput).toBe(true);
    controller.record(ChangeSet.of({ from: 0, to: 5 }, 5), {});
    expect(controller.hasMeaningfulUserInput).toBe(true);
    controller.dispose();
  });

  it("does no persisted-range reads during native input and rebases composed adjacent typing once", () => {
    let reads = 0;
    const ranges = Array.from({ length: MAX_TEXT_STYLE_RANGES }, (_, index) => ({
      get start() {
        reads += 1;
        return index * 2;
      },
      end: index * 2 + 1,
      style: { underline: true },
    }));
    const source = "x ".repeat(MAX_TEXT_STYLE_RANGES);
    const { controller, frames, onChange, onPending } = harness(source, ranges);
    controller.record(ChangeSet.of({ from: 0, insert: "a" }, source.length), {});
    controller.record(ChangeSet.of({ from: 1, insert: "b" }, source.length + 1), {});
    controller.record(ChangeSet.of({ from: 2, insert: "c" }, source.length + 2), {});
    expect(reads).toBe(0);
    expect(frames.pendingCount).toBe(1);
    frames.runNext();
    expect(controller.state.source).toBe(`abc${source}`);
    expect(controller.state.ranges[0]?.start).toBe(3);
    expect(reads).toBeLessThanOrEqual(MAX_TEXT_STYLE_RANGES * 3);
    expect(onChange).toHaveBeenCalledOnce();
    const mapping = onChange.mock.lastCall?.[1];
    expect(mapping?.mapPos(0, -1)).toBe(0);
    expect(mapping?.mapPos(0, 1)).toBe(3);
    const next = ChangeSet.of({ from: 3, insert: "!" }, source.length + 3);
    expect(mapping?.composeDesc(next).mapPos(2, 1)).toBe(6);
    expect(onPending.mock.calls).toEqual([[true], [false]]);
    controller.dispose();
  });

  it("ignores a suspended stale materialization and flushes the latest composed native changes", async () => {
    const { controller, frames, scheduler, onChange, onError, onPending } = harness("word", [
      { start: 0, end: 4, style: { bold: true } },
    ]);
    let resume: (() => void) | undefined;
    let paused = true;
    scheduler.checkpoint = () =>
      paused
        ? new Promise<void>((resolve) => {
            resume = resolve;
          })
        : undefined;
    controller.record(ChangeSet.of({ from: 4, insert: "!" }, 4), {});
    frames.runNext();
    controller.record(ChangeSet.of({ from: 5, insert: "?" }, 5), {});
    paused = false;
    const flushed = controller.flushChanges();
    resume?.();
    await flushed;
    expect(controller.state.source).toBe("word!?");
    expect(onChange).toHaveBeenCalledOnce();
    expect(onPending.mock.calls).toEqual([[true], [false]]);
    expect(onError).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("cancels native source callbacks on disposal and releases the pending guard", () => {
    const { controller, frames, onChange, onPending } = harness("word");
    controller.record(ChangeSet.of({ from: 4, insert: "!" }, 4), {});
    controller.dispose();
    expect(frames.pendingCount).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
    expect(onPending.mock.calls).toEqual([[true], [false]]);
  });
});
