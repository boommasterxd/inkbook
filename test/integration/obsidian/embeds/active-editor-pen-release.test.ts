import { describe, expect, it, vi } from "vitest";

import {
  createInputState,
  type EditorTool,
  type PointerSample,
} from "../../../../src/editor/input/index";
import { LiveStrokeBuilder, type LiveStrokeCommit } from "../../../../src/editor/tools/live-stroke";
import { CoalescedPointerInput } from "../../../../src/obsidian/embeds/active-editor/coalesced-input";
import {
  ActiveEditorPointerController,
  type ActiveEditorPointerOptions,
} from "../../../../src/obsidian/embeds/active-editor/controller-pointer";
import { ManualFrameScheduler } from "../../../fixtures/obsidian/manual-frame-scheduler";

const style = {
  color: { type: "theme-text" as const },
  opacity: 1,
  pressureEnabled: true,
  smoothing: 0.5 as const,
  width: 22 as const,
};

describe("pen drawing release at the controller boundary", () => {
  it("preserves the final visible contact pressure and geometry on a zero-pressure release", () => {
    const fixture = setup();
    fixture.controller.handlePointerMove(event(30, 0.6375, 2));
    fixture.scheduler.runNext();
    const visible = fixture.builder.preview().tail.geometry;

    fixture.controller.handlePointerUp(event(30, 0, 3, { buttons: 0 }));

    expect(fixture.committed()?.points.slice(-3)).toEqual([30, 20, 0.6375]);
    expect(fixture.committed()?.geometry).toEqual(visible);
  });

  it("flushes queued contact samples before committing a release with no additional contact", () => {
    const fixture = setup();
    fixture.controller.handlePointerMove(event(30, 0.6375, 2));
    fixture.controller.handlePointerUp(event(40, 0, 3, { buttons: 0 }));

    expect(fixture.scheduler.pendingCount).toBe(0);
    expect(fixture.committed()?.points.slice(-3)).toEqual([30, 20, 0.6375]);
  });

  it.each([0.25, 0])("keeps coalesced final contact and real taper pressure %s", (pressure) => {
    const fixture = setup();
    const contact = event(35, pressure, 3);
    fixture.controller.handlePointerMove(event(30, 0.6375, 2));
    fixture.controller.handlePointerUp(
      event(40, 0, 4, {
        buttons: 0,
        getCoalescedEvents: () => [contact],
      }),
    );

    expect(fixture.committed()?.points.slice(-3)).toEqual([35, 20, pressure]);
  });

  it("retains a release sample when the device still reports contact pressure", () => {
    const fixture = setup();
    fixture.controller.handlePointerUp(event(40, 0.2, 3, { buttons: 0 }));

    expect(fixture.committed()?.points.slice(-3)).toEqual([40, 20, 0.2]);
  });

  it("rejects invalid coalesced release data before committing any stroke", () => {
    const fixture = setup();
    fixture.controller.handlePointerUp(
      event(40, 0, 4, {
        buttons: 0,
        getCoalescedEvents: () => [event(35, Number.NaN, 3)],
      }),
    );

    expect(fixture.committed()).toBeUndefined();
    expect(fixture.cancelled).toHaveBeenCalledOnce();
  });

  it.each([
    ["pen", "rectangle"],
    ["mouse", "draw"],
    ["touch", "draw"],
  ] as const)("retains final coordinates for %s %s", (pointerType, tool) => {
    const fixture = setup(pointerType, tool);
    fixture.controller.handlePointerUp(event(40, 0, 3, { buttons: 0, pointerType }));

    expect(fixture.committed()?.points.slice(-3, -1)).toEqual([40, 20]);
  });
});

function setup(pointerType: PointerSample["pointerType"] = "pen", tool: EditorTool = "draw") {
  const scheduler = new ManualFrameScheduler();
  const builder = new LiveStrokeBuilder({ input: { pressureSource: "pen", zoom: 1 }, style });
  builder.append({ x: 10, y: 20, pressure: 0.5, time: 1 });
  let committed: LiveStrokeCommit | undefined;
  const cancelled = vi.fn();
  const project = (value: PointerEvent): PointerSample => ({
    pointerId: value.pointerId,
    pointerType,
    pressure: value.pressure,
    x: value.clientX,
    y: value.clientY,
  });
  const coalesced = new CoalescedPointerInput({
    dispatchMove: (pointer) => routed.update(pointer),
    frameScheduler: scheduler,
    now: () => 0,
    project,
  });
  const preview = {
    frameSampleMode: "preserve" as const,
    update: vi.fn(),
    updateSamples: (samples: readonly (PointerSample & { time: number })[]) => {
      builder.appendBatch(samples.map((sample) => ({ ...sample, pressure: sample.pressure ?? 0 })));
    },
    commit: () => {
      committed = builder.finish();
      return true;
    },
    revert: cancelled,
  };
  const routed = coalesced.wrap(preview);
  const interaction = {
    phase: "tool-gesture" as const,
    pointerId: 1,
    pointerType,
    penRole: "normal" as const,
    current: { x: 10, y: 20 },
    start: { x: 10, y: 20 },
    tool,
    previousTool: tool,
    previewStarted: true,
    longPressScheduled: false,
    temporaryEraser: false,
    shift: false,
  };
  const controller = new ActiveEditorPointerController({
    coalesced,
    dispatch: (action) => {
      if (action.type === "pointer-up") routed.commit();
      if (action.type === "pointer-cancel") routed.revert();
    },
    getInput: () => ({ ...createInputState(), interaction }),
    handles: {
      pointerMove: () => false,
      pointerUp: () => false,
      cancel: () => false,
    } as unknown as ActiveEditorPointerOptions["handles"],
    navigation: {
      screenPointer: project,
      pageSample: (sample: PointerSample) => sample,
      cancelPanMomentum: vi.fn(),
    } as unknown as ActiveEditorPointerOptions["navigation"],
    capturePointer: vi.fn(),
    beginHandlePointer: vi.fn(),
    finishHandlePointer: vi.fn(),
    interruptForInput: vi.fn(),
    isEnabled: () => true,
    releasePointer: vi.fn(),
    selection: () => new Set(),
    setLastPointer: vi.fn(),
    menus: {} as ActiveEditorPointerOptions["menus"],
    ownerWindow: {} as Window,
    renderer: {} as ActiveEditorPointerOptions["renderer"],
    sceneStore: {} as ActiveEditorPointerOptions["sceneStore"],
  });
  return { builder, cancelled, committed: () => committed, controller, scheduler };
}

function event(
  x: number,
  pressure: number,
  timeStamp: number,
  overrides: Partial<PointerEvent> = {},
): PointerEvent {
  return {
    pointerId: 1,
    pointerType: "pen",
    clientX: x,
    clientY: 20,
    pressure,
    timeStamp,
    buttons: 1,
    cancelable: false,
    ...overrides,
  } as PointerEvent;
}
