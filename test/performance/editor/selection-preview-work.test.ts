import { describe, expect, it } from "vitest";

import { ElementStore } from "../../../src/domain/store/public";
import { SelectionHandleSession } from "../../../src/editor/selection/handle-session";
import { maximumStroke } from "./maximum-stroke-fixture";

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
});
