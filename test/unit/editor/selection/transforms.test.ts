import { describe, expect, it } from "vitest";

import type {
  InkElementV1,
  LineElementV1,
  StrokeElementV1,
  TableElementV1,
} from "../../../../src/domain/schema/public";
import { validateInkElementV1 } from "../../../../src/domain/schema/public";
import {
  editLinearBend,
  editLinearEndpoint,
  moveSelection,
  moveSelectionTimeSliced,
  rotateSelection,
  scaleSelectionUniform,
  uniformScaleFactorFromPointers,
} from "../../../../src/editor/selection/public";
import { hydrateRuntimeStroke } from "../../../fixtures/domain/runtime-stroke-store";

const style = {
  outlineColor: { type: "theme-text" as const },
  outlineWidth: 4 as const,
  outlineOpacity: 1,
  outlineStyle: "solid" as const,
};

function line(): LineElementV1 {
  return {
    id: "line",
    kind: "line",
    createdAt: 1,
    rotation: 0,
    pivot: { x: 5, y: 0 },
    start: { x: 0, y: 0 },
    end: { x: 10, y: 0 },
    bend: null,
    startConnection: { targetId: "target", anchor: { kind: "box", position: "top-left" } },
    endConnection: null,
    startNode: "none",
    endNode: "none",
    style,
  };
}

function table(): TableElementV1 {
  return {
    id: "table",
    kind: "table",
    createdAt: 2,
    rotation: 0,
    pivot: { x: 60, y: 40 },
    x: 0,
    y: 0,
    columnWidth: 40,
    columns: 3,
    height: 80,
    headerHeight: 24,
    style,
  };
}

function scalableTable(id: string, headerHeight: number): TableElementV1 {
  return {
    ...table(),
    columnWidth: 100,
    headerHeight,
    height: 200,
    id,
    pivot: { x: 150, y: 100 },
  };
}

function runtimeStroke(): StrokeElementV1 {
  return {
    createdAt: 3,
    id: "00000000-0000-4000-8000-000000000003",
    kind: "stroke",
    pivot: { x: 15, y: 15 },
    points: [10, 10, 0.5, 20, 20, 0.75],
    rotation: 0,
    style: {
      color: { type: "theme-text" },
      opacity: 1,
      pressureEnabled: true,
      smoothing: 0.5,
      width: 4,
    },
    tool: "pen",
  };
}

function translationRoundingGeometry() {
  return {
    height: 429.471,
    pivot: { x: 1099.695, y: 1022.904 },
    x: 655.405,
    y: 808.169,
  };
}

function expectValidRoundingSensitiveTranslation(source: InkElementV1): void {
  const moved = moveSelection([source], { x: -100, y: 40 })[0]!;
  expect(moved.pivot).toEqual({ x: 999.694, y: 1062.905 });
  expect(validateInkElementV1(moved).ok).toBe(true);
}

describe("selection transforms", () => {
  it("preserves exclusively owned runtime stroke buffers through a move", async () => {
    const source = runtimeStroke();
    const { store, stroke: stored } = await hydrateRuntimeStroke(source);

    const moved = moveSelection([stored], { x: 5, y: 7 })[0];

    expect(moved?.kind).toBe("stroke");
    if (moved?.kind !== "stroke") return;
    expect(moved.points).toBeInstanceOf(Float64Array);
    expect(moved.points.slice(0, 3)).toEqual(new Float64Array([15, 17, 0.5]));
    expect(() => store.replace(source.id, moved)).not.toThrow();
    expect(store.get(source.id)?.element.kind === "stroke").toBe(true);
  });

  it("moves free linear geometry without detaching or moving connected endpoints", () => {
    const moved = moveSelection([line()], { x: 5, y: 7 })[0] as LineElementV1;
    expect(moved.start).toEqual({ x: 0, y: 0 });
    expect(moved.end).toEqual({ x: 15, y: 7 });
    expect(moved.startConnection?.targetId).toBe("target");
  });

  it("yields between bounded transform batches and supports cancellation", async () => {
    let yields = 0;
    const moved = await moveSelectionTimeSliced(
      [table(), table()],
      { x: 5, y: 7 },
      {
        shouldYield: () => true,
        yieldControl: async () => {
          yields += 1;
        },
      },
    );
    expect(moved?.map(({ pivot }) => pivot)).toEqual([
      { x: 65, y: 47 },
      { x: 65, y: 47 },
    ]);
    expect(yields).toBe(2);

    const cancelled = await moveSelectionTimeSliced(
      [table()],
      { x: 1, y: 1 },
      {
        isCancelled: () => true,
        shouldYield: () => false,
        yieldControl: async () => undefined,
      },
    );
    expect(cancelled).toBeNull();

    let cancelledAfterYield = false;
    const cancelledAtBoundary = await moveSelectionTimeSliced(
      [table()],
      { x: 1, y: 1 },
      {
        isCancelled: () => cancelledAfterYield,
        shouldYield: () => true,
        yieldControl: async () => {
          cancelledAfterYield = true;
        },
      },
    );
    expect(cancelledAtBoundary).toBeNull();
  });
});

describe("selection transform validation", () => {
  it("rejects translated stroke coordinates outside the schema range", () => {
    const stroke: StrokeElementV1 = {
      createdAt: 1,
      id: "stroke",
      kind: "stroke",
      pivot: { x: 1_000_000, y: 0 },
      points: [1_000_000, 0, 0.5],
      rotation: 0,
      style: {
        color: { type: "theme-text" },
        opacity: 1,
        pressureEnabled: true,
        smoothing: 0.5,
        width: 4,
      },
      tool: "pen",
    };

    expect(() => moveSelection([stroke], { x: 0.001, y: 0 })).toThrow(RangeError);
  });

  it("derives a translated table pivot from the canonical moved origin", () => {
    const source: TableElementV1 = {
      ...table(),
      ...translationRoundingGeometry(),
      columnWidth: 296.193,
      columns: 3,
      headerHeight: 128.841,
      id: "00000000-0000-4000-8000-000000000008",
    };

    expectValidRoundingSensitiveTranslation(source);
  });

  it("derives a translated box pivot from the canonical moved origin", () => {
    const source = {
      createdAt: 4,
      ...translationRoundingGeometry(),
      id: "00000000-0000-4000-8000-000000000007",
      kind: "rectangle" as const,
      rotation: 0,
      style: { ...style, fillColor: null, fillOpacity: 0 },
      width: 888.579,
    };

    expectValidRoundingSensitiveTranslation(source);
  });
});

describe("selection transform constraints", () => {
  it("ignores pointer motion perpendicular to a uniform resize handle direction", () => {
    const anchor = { x: 100, y: 100 };
    const start = { x: 700, y: 100 };

    expect(uniformScaleFactorFromPointers(anchor, start, { x: 1_000, y: 100 })).toBe(1.5);
    expect(uniformScaleFactorFromPointers(anchor, start, { x: 1_000, y: 480 })).toBe(1.5);
    expect(uniformScaleFactorFromPointers(anchor, start, { x: 1_000, y: -280 })).toBe(1.5);
  });

  it("clamps a uniform resize after the pointer crosses its fixed anchor", () => {
    const factor = uniformScaleFactorFromPointers(
      { x: 100, y: 100 },
      { x: 700, y: 100 },
      { x: 50, y: 600 },
      0.2,
    );

    expect(factor).toBe(0.2);
  });

  it("scales structural geometry while preserving paint widths", () => {
    const scaled = scaleSelectionUniform([table()], { x: 0, y: 0 }, 2)[0] as TableElementV1;
    expect(scaled).toMatchObject({ columnWidth: 80, height: 160, headerHeight: 48 });
    expect(scaled.style.outlineWidth).toBe(4);
  });

  it("derives a scaled table pivot from its canonical dimensions", () => {
    const source: TableElementV1 = {
      ...table(),
      id: "00000000-0000-4000-8000-000000000006",
      x: 100,
      y: 100,
      columnWidth: 40,
      columns: 1,
      height: 80.002,
      headerHeight: 24,
      pivot: { x: 120, y: 140.001 },
      rotation: 43.744,
    };

    const scaled = scaleSelectionUniform([source], { x: 100, y: 100 }, 1.255)[0]!;

    expect(scaled.pivot.y).toBe(150.202);
    expect(validateInkElementV1(scaled).ok).toBe(true);
  });

  it("uses the strictest table header minimum during uniform group scaling", () => {
    const first = scalableTable("00000000-0000-4000-8000-000000000004", 30);
    const second = scalableTable("00000000-0000-4000-8000-000000000005", 40);

    const [scaledFirst, scaledSecond] = scaleSelectionUniform(
      [first, second],
      { x: 0, y: 0 },
      0.5,
    ) as [TableElementV1, TableElementV1];

    expect(scaledFirst).toMatchObject({ columnWidth: 80, headerHeight: 24, height: 160 });
    expect(scaledSecond).toMatchObject({ columnWidth: 80, headerHeight: 32, height: 160 });
    expect(validateInkElementV1(scaledFirst).ok).toBe(true);
    expect(validateInkElementV1(scaledSecond).ok).toBe(true);
  });

  it("rotates, bends, and edits an endpoint with one canonical replacement per operation", () => {
    const rotated = rotateSelection([table()], { x: 0, y: 0 }, 90)[0] as TableElementV1;
    expect(rotated.pivot).toEqual({ x: -40, y: 60 });
    expect(rotated.rotation).toBe(90);
    const bent = editLinearBend(line(), { x: 5, y: 5 }) as LineElementV1;
    expect(bent.bend).toEqual({ x: 5, y: 5 });
    const edited = editLinearEndpoint(bent, "start", { x: -8, y: 0 }) as LineElementV1;
    expect(edited.startConnection).toBeNull();
  });
});
