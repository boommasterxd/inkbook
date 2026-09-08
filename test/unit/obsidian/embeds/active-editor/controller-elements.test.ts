import { describe, expect, it } from "vitest";

import { ElementStore } from "../../../../../src/domain/store/public";
import { selectionTargetAt } from "../../../../../src/obsidian/embeds/active-editor/controller-elements";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { connectedLine, IDS, rectangle } from "../../../domain/store/fixtures";

describe("active editor selection targets", () => {
  it.each(["mouse", "pen", "touch"] as const)(
    "moves a transparent box selection from its highlighted interior with %s input",
    (pointerType) => {
      const element = rectangle();
      const fixture = scene([element]);

      expect(
        selectionTargetAt(fixture.store, new Set([element.id]), element.pivot, pointerType, 1),
      ).toEqual({ elementId: element.id, isSelected: true });
      fixture.release();
    },
  );

  it("prioritizes the selection overlay over an unselected element underneath", () => {
    const selected = rectangle();
    const underneath = {
      ...rectangle(IDS.other),
      createdAt: 2,
      style: {
        ...rectangle(IDS.other).style,
        fillColor: { type: "rgba", value: "#112233FF" } as const,
        fillOpacity: 1,
      },
    };
    const fixture = scene([selected, underneath]);

    expect(
      selectionTargetAt(fixture.store, new Set([selected.id]), selected.pivot, "mouse", 1),
    ).toEqual({ elementId: selected.id, isSelected: true });
    fixture.release();
  });

  it("moves a group from the transparent gap inside its shared bounding box", () => {
    const left = rectangle();
    const right = rectangle(IDS.other, 500, 100);
    const fixture = scene([left, right]);

    expect(
      selectionTargetAt(
        fixture.store,
        new Set([left.id, right.id]),
        { x: 400, y: 150 },
        "mouse",
        1,
      ),
    ).toEqual({ elementId: left.id, isSelected: true });
    fixture.release();
  });

  it("does not invent a target when there is no selection", () => {
    const element = rectangle();
    const fixture = scene([element]);

    expect(selectionTargetAt(fixture.store, new Set(), element.pivot, "mouse", 1)).toBeUndefined();
    fixture.release();
  });

  it.each(["line", "arrow"] as const)(
    "does not turn a single %s centerline into a rectangular move target",
    (kind) => {
      const element = {
        ...connectedLine(),
        bend: { x: 250, y: 0 },
        kind,
        startConnection: null,
      };
      const fixture = scene([element]);

      expect(
        selectionTargetAt(fixture.store, new Set([element.id]), { x: 250, y: 95 }, "mouse", 1),
      ).toBeUndefined();
      fixture.release();
    },
  );
});

function scene(elements: ConstructorParameters<typeof ElementStore>[0]) {
  const store = new ElementSceneStore(new ElementStore(elements));
  return { release: () => store.release(), store };
}
