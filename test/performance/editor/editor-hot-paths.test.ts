import { describe, expect, it } from "vitest";

import { EraserSweep } from "../../../src/editor/gestures/public";
import { ElementStore } from "../../../src/domain/store/public";
import { SelectionHandleSession } from "../../../src/editor/selection/handle-session";
import { maximumStroke } from "./maximum-stroke-fixture";
import { createPassThroughMoveSession } from "./selection-session-fixture";
import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";
import { expectTiming } from "../timing-assertions";

describe("editor gesture hot paths", () => {
  it.each([512, 4_096])(
    "previews a %i-point selection without reading or copying its points",
    (count) => {
      for (const kind of ["move", "scale"] as const) {
        const source = maximumStroke(0);
        let pointReads = 0;
        const points = new Proxy(source.points.slice(0, count * 3), {
          get(target, property, receiver): unknown {
            if (typeof property === "string" && /^\d+$/.test(property)) pointReads += 1;
            return Reflect.get(target, property, receiver);
          },
        });
        const stroke = { ...source, points };
        const store = new ElementStore([stroke]);
        const session = new SelectionHandleSession({
          action:
            kind === "move"
              ? { kind }
              : { kind, anchor: { x: -1, y: -1 }, position: "bottom-right", rotation: 0 },
          elements: [stroke],
          planner: store,
          startPointer: { x: count + 1, y: 102 },
        });
        pointReads = 0;
        store.resetInstrumentation();
        for (let frame = 1; frame <= 120; frame += 1) {
          const preview = session.update({ x: count + 1 + frame, y: 102 + frame });
          expect(preview.exactElements).toHaveLength(0);
          expect(preview.exactPreviewTruncated).toBe(true);
          expect(preview.transform?.kind).toBe(kind === "move" ? "translate" : "scale");
        }
        expect(pointReads).toBe(0);
        expect(stroke.points).toBe(points);
        expect(store.instrumentation).toMatchObject({
          fullStoreScans: 0,
          snapshotMaterializations: 0,
          recordReplacements: 0,
          identityChecks: 0,
        });
        session.cancel();
      }
    },
  );

  it("bounds maximum-stroke preview and eraser work independently of sweep length", () => {
    const strokes = Array.from({ length: 256 }, (_, index) => maximumStroke(index));
    const byId = new Map(strokes.map((stroke) => [stroke.id, stroke]));
    const ids = strokes.map(({ id }) => id);
    const previewDurations: number[] = [];
    const eraserDurations: number[] = [];

    for (let run = 0; run < 6; run += 1) {
      const session = createPassThroughMoveSession(strokes, { x: -1_000, y: 0 });
      let started = performance.now();
      const preview = session.update({ x: 5_000, y: 0 });
      const previewDuration = performance.now() - started;

      started = performance.now();
      const eraser = new EraserSweep(
        { x: -1_000, y: 0 },
        4,
        (() => {
          let queryCount = 0;
          return {
            getElement: (id) => byId.get(id),
            query: (_bounds, sink) => {
              if (queryCount++ === 1) for (const id of ids) sink.add(id);
            },
          };
        })(),
        { clearCandidateFade: () => undefined, setCandidateFade: () => undefined },
      );
      eraser.update({ x: 5_000, y: 0 });
      const eraserDuration = performance.now() - started;
      while (eraser.candidateCount < strokes.length) {
        started = performance.now();
        eraser.update({ x: 5_000, y: 0 });
        eraserDurations.push(performance.now() - started);
      }
      expect(preview.exactPreviewTruncated).toBe(true);
      expect(eraser.candidateCount).toBe(256);
      if (run > 0) {
        previewDurations.push(previewDuration);
        eraserDurations.push(eraserDuration);
      }
    }

    expectTiming(Math.max(...previewDurations), INTERACTION_REFRESH_PROFILE.mainThreadP99Ms);
    expectTiming(Math.max(...eraserDurations), 250);
  });
});
