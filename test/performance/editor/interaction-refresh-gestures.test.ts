import { describe, expect, it } from "vitest";

import type { InkElementV1, PointV1 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import { EraserSweep } from "../../../src/editor/gestures/public";
import type { SelectionReplacementPlanner } from "../../../src/editor/selection/handle-session";
import {
  SelectionHandleSession,
  type SelectionHandleAction,
  type SelectionHandlePreview,
} from "../../../src/editor/selection/public";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import { indexedStroke } from "../../fixtures/editor/stroke";
import { rectangle } from "../../unit/domain/store/fixtures";
import {
  INTERACTION_REFRESH_PROFILE,
  interactionP99,
  interactionProfileAnnotation,
  measureInteractionFrames,
} from "../interaction-refresh-profile";
import { timingBudget } from "../timing-budget";

const ELEMENT_COUNT = 10_000;
const PLANNER: SelectionReplacementPlanner = {
  countReverseDependencies: () => 0,
  planReplacements: (replacements) => ({ elements: replacements, replacements }),
  planReplacementsTimeSliced: async (replacements) => ({
    elements: replacements,
    replacements,
  }),
};

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz editor gesture profile`, () => {
  it("keeps indexed eraser feedback within budget", async ({ annotate }) => {
    const store = new ElementStore(interactionStrokes());
    const sceneStore = new ElementSceneStore(store);
    const eraser = new EraserSweep(
      { x: 20, y: 20 },
      4,
      {
        getElement: (id) => sceneStore.get(id)?.element,
        query: (bounds, sink) => sceneStore.query(bounds, sink),
      },
      {
        addCandidateFade: () => undefined,
        clearCandidateFade: () => undefined,
        setCandidateFade: () => undefined,
      },
    );
    store.resetInstrumentation();

    let rejectedUpdates = 0;
    const durations = measureInteractionFrames((frame) => {
      const point = eraserPoint(frame);
      if (eraser.update(point) !== "accepted") rejectedUpdates += 1;
    });

    const p99 = interactionP99(durations);
    expect(rejectedUpdates).toBe(0);
    expect(eraser.candidateCount).toBeGreaterThan(0);
    expect(store.instrumentation.fullStoreScans).toBe(0);
    expect(p99).toBeLessThanOrEqual(timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms));
    await annotate(interactionProfileAnnotation("eraser feedback", p99), "performance");
    eraser.revert();
    sceneStore.release();
  });

  it("keeps move, scale, rotate, and shape-resize previews within budget", async ({ annotate }) => {
    const elements = interactionStrokes();
    const sessions = selectionSessions(elements);
    for (const profile of sessions) {
      let preview: SelectionHandlePreview | undefined;
      const durations = measureInteractionFrames((frame) => {
        preview = profile.session.update(profile.pointer(frame));
      });
      const p99 = interactionP99(durations);
      if (profile.usesTransform) {
        expect(preview?.transform).not.toBeNull();
      } else {
        expect(preview?.transform).toBeNull();
        expect(preview?.exactElements).toHaveLength(1);
      }
      expect(preview?.exactPreviewTruncated).toBe(profile.truncated);
      expect(p99).toBeLessThanOrEqual(timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms));
      await annotate(interactionProfileAnnotation(profile.name, p99), "performance");
    }
  });
});

function interactionStrokes(): InkElementV1[] {
  return Array.from({ length: ELEMENT_COUNT }, (_, index) => indexedStroke(index));
}

function eraserPoint(frame: number): PointV1 {
  const column = frame % 100;
  const row = Math.floor(frame / 100);
  return {
    x: 20 + (row % 2 === 0 ? column : 99 - column) * 10,
    y: 20 + row * 10,
  };
}

interface SelectionProfile {
  readonly name: string;
  readonly pointer: (frame: number) => PointV1;
  readonly session: SelectionHandleSession;
  readonly truncated: boolean;
  readonly usesTransform: boolean;
}

function selectionSessions(elements: readonly InkElementV1[]): readonly SelectionProfile[] {
  const shape = rectangle("20000000-0000-4000-8000-000000000001", 100, 100);
  return [
    selectionProfile("selection move preview", elements, { kind: "move" }, { x: 0, y: 0 }),
    selectionProfile(
      "selection scale preview",
      elements,
      { anchor: { x: 0, y: 0 }, kind: "scale", position: "bottom-right" },
      { x: 1_000, y: 1_000 },
    ),
    selectionProfile(
      "selection rotate preview",
      elements,
      { center: { x: 500, y: 500 }, kind: "rotate" },
      { x: 1_000, y: 500 },
    ),
    selectionProfile(
      "shape resize preview",
      [shape],
      { elementId: shape.id, kind: "shape-resize", position: "bottom-right" },
      { x: 300, y: 200 },
      false,
      false,
    ),
  ];
}

function selectionProfile(
  name: string,
  elements: readonly InkElementV1[],
  action: SelectionHandleAction,
  startPointer: PointV1,
  truncated = true,
  usesTransform = true,
): SelectionProfile {
  return {
    name,
    pointer: (frame) => ({
      x: startPointer.x + 10 + Math.sin(frame / 20) * 5,
      y: startPointer.y + 10 + Math.cos(frame / 20) * 5,
    }),
    session: new SelectionHandleSession({ action, elements, planner: PLANNER, startPointer }),
    truncated,
    usesTransform,
  };
}
