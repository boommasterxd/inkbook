// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { ElementStore } from "../../../../../src/domain/store/public";
import type { PointerSample } from "../../../../../src/editor/input/index";
import { TextEntryHandoff } from "../../../../../src/obsidian/embeds/active-editor/text-entry-handoff";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { textElement } from "../../../../fixtures/rendering/text";
import { textActivationPointer } from "../../../../fixtures/obsidian/selected-text-activation";
import { rotatePointClockwise } from "../../../../../src/domain/geometry/public";

it("protects contacts in the pending field's empty rectangle and releases on settlement", async () => {
  const element = textElement({ backgroundColor: null, backgroundOpacity: 0, rotation: 25 });
  const store = new ElementStore([element]);
  let release!: (success: boolean) => void;
  const editing = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const edit = vi.fn(() => editing);
  const scheduler = immediateWorkScheduler();
  const frame = vi.spyOn(scheduler, "requestFrame");
  const navigation = {
    screenPointer: (event: PointerEvent) => ({
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      pointerType: "mouse" as const,
      pressure: event.pressure,
      time: event.timeStamp,
    }),
    pageSample: (sample: PointerSample) => sample,
  };
  const entry = new TextEntryHandoff({ store, edit, ownerWindow: window, scheduler, navigation });
  const down = (options: PointerEventInit = {}) =>
    textActivationPointer("pointerdown", "mouse", options);
  const reads = vi.spyOn(store, "get");
  try {
    entry.activate(element.id, element.source.length);
    entry.activate(element.id, 0);
    expect(edit).toHaveBeenCalledExactlyOnceWith(element.id, element.source.length);
    expect(entry.claim(down())).toBe(true);
    const blank = rotatePointClockwise({ x: 190, y: 110 }, element.pivot, element.rotation);
    expect(entry.claim(down({ pointerType: "touch", clientX: blank.x, clientY: blank.y }))).toBe(
      true,
    );
    const count = reads.mock.calls.length;
    for (const options of [
      { button: 2 },
      { button: 5, pointerType: "pen" },
      { buttons: 3 },
      { pointerType: "pen", pressure: 0 },
      { isPrimary: false },
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { shiftKey: true },
    ])
      expect(entry.claim(down(options))).toBe(false);
    expect(reads).toHaveBeenCalledTimes(count);
    expect(entry.claim(down({ clientX: 500, clientY: 500 }))).toBe(false);
    release(true);
    await editing;
    expect(entry.pending).toBe(false);
    const settledReads = reads.mock.calls.length;
    expect(entry.claim(down())).toBe(false);
    expect(reads).toHaveBeenCalledTimes(settledReads);
    expect(frame).not.toHaveBeenCalled();
    entry.dispose();
    entry.activate(element.id, 0);
    expect(edit).toHaveBeenCalledOnce();
  } finally {
    release(false);
    entry.dispose();
    vi.restoreAllMocks();
  }
});
