import type { CoalescedPointerInput } from "../../../src/obsidian/embeds/active-editor/coalesced-input";
import type { CreationPreview } from "../../../src/obsidian/embeds/active-editor/creation-preview";

type PreviewOptions = ConstructorParameters<typeof CreationPreview>[0];
type InputOptions = ConstructorParameters<typeof CoalescedPointerInput>[0];

export function livePreviewOptions(
  defaults: PreviewOptions["defaults"],
  history: PreviewOptions["history"],
  renderer: PreviewOptions["renderer"],
  pointerType: "pen" | "mouse",
): PreviewOptions {
  return {
    defaults,
    history,
    identity: { createdAt: 0, id: "00000000-0000-4000-8000-999999999999" },
    renderer,
    start: {
      additive: false,
      kind: "tool-gesture",
      pointer: { pointerId: 1, pointerType, pressure: 0.5, x: 0, y: 50 },
      tool: "draw",
    },
  };
}

export function liveInputOptions(
  scheduler: NonNullable<InputOptions["frameScheduler"]> & { now(): number },
  dispatchMove: InputOptions["dispatchMove"],
  pointerType: "pen" | "mouse",
): InputOptions {
  return {
    dispatchMove,
    frameScheduler: scheduler,
    now: () => scheduler.now(),
    project: (event) => ({
      pointerId: 1,
      pointerType,
      pressure: event.pressure,
      x: event.clientX,
      y: event.clientY,
    }),
  };
}
