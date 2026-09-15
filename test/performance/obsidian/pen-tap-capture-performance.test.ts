// @vitest-environment happy-dom

import { expect, it } from "vitest";

import {
  mountPenTapEditor,
  penEvent,
  penTapSurface,
} from "../../fixtures/obsidian/pen-tap-extension";
import { interactionP99, INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { expectTiming } from "../timing-assertions";

it.for(["touch", "widget", "padding"])(
  "keeps %s pointer capture inside the input budget",
  async (surface, { annotate }) => {
    const editor = mountPenTapEditor();
    const { target, pointerType } = penTapSurface(editor, surface);
    const durations: number[] = [];
    try {
      for (let sample = -50; sample < INTERACTION_REFRESH_PROFILE.sampleCount; sample += 1) {
        const down = penEvent("pointerdown", { pointerType });
        const up = penEvent("pointerup", { pointerType });
        const click = penEvent("click", { pointerType });
        const started = performance.now();
        target.dispatchEvent(down);
        target.dispatchEvent(up);
        target.dispatchEvent(click);
        if (sample >= 0) durations.push(performance.now() - started);
      }
      const p99 = interactionP99(durations);
      expectTiming(p99, INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
      if (surface === "padding") {
        const attempts = INTERACTION_REFRESH_PROFILE.sampleCount + 50;
        expect(editor.command).toHaveBeenCalledTimes(attempts);
        expect(editor.posAtCoords).toHaveBeenCalledTimes(attempts);
        // Validate once on pointerdown and revalidate once before insertion on pointerup.
        expect(editor.canInsertAtLine).toHaveBeenCalledTimes(attempts * 2);
        expect(editor.setCursor).toHaveBeenCalledTimes(attempts);
      } else {
        expect(editor.posAtCoords).not.toHaveBeenCalled();
        expect(editor.command).not.toHaveBeenCalled();
      }
      await annotate(`Pen capture ${surface} p99=${p99.toFixed(3)} ms`, "performance");
    } finally {
      editor.destroy();
    }
  },
);
