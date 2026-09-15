import { expect } from "vitest";
import {
  mountPenTapEditor,
  penEvent,
  penTapSurface,
} from "../../fixtures/obsidian/pen-tap-extension";
import type { ComparisonScenario } from "./contracts";

export const OBSIDIAN_PEN_TAP_SCENARIOS: readonly ComparisonScenario[] = [
  "touch",
  "widget",
  "padding",
].map((surface) => ({
  id: `obsidian-pen-tap-${surface}`,
  modules: ["obsidian/commands/pen-tap-extension", "obsidian/commands/pen-tap-insertion"],
  covers: [
    {
      file: "test/performance/obsidian/pen-tap-capture-performance.test.ts",
      test: `keeps ${surface} pointer capture inside the input budget`,
      ordinals: [1],
    },
  ],
  statistics: [{ kind: "p99", population: "operations", minimumSamples: 100 }],
  execution: "sync",

  warmupOperations: 20,
  create(implementation) {
    const editor = mountPenTapEditor("Text\n", {
      ...implementation.get<typeof import("../../../src/obsidian/commands/pen-tap-extension")>(
        "obsidian/commands/pen-tap-extension",
      ),
      ...implementation.get<typeof import("../../../src/obsidian/commands/pen-tap-insertion")>(
        "obsidian/commands/pen-tap-insertion",
      ),
    });
    const { target, pointerType } = penTapSurface(editor, surface);
    let events: PointerEvent[] = [];
    return {
      reset() {
        editor.command.mockClear();
        editor.posAtCoords.mockClear();
        editor.canInsertAtLine.mockClear();
        editor.setCursor.mockClear();
        events = ["pointerdown", "pointerup", "click"].map((type) =>
          penEvent(type, { pointerType }),
        );
      },
      run() {
        for (const event of events) target.dispatchEvent(event);
      },
      verify() {
        if (surface === "padding") {
          expect(editor.command).toHaveBeenCalledOnce();
          expect(editor.posAtCoords).toHaveBeenCalledOnce();
          expect(editor.canInsertAtLine).toHaveBeenCalledTimes(2);
          expect(editor.setCursor).toHaveBeenCalledOnce();
        } else {
          expect(editor.posAtCoords).not.toHaveBeenCalled();
          expect(editor.command).not.toHaveBeenCalled();
        }
      },
      dispose: () => editor.destroy(),
    };
  },
}));
