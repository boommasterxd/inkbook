/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact geometry fixtures and boundary values. */

import { describe, expect, it } from "vitest";

import {
  deriveAggregateSelectionModelV1,
  deriveElementSelectionModelV1,
  transformFramePointV1,
} from "../../../src/domain/geometry";
import type {
  ElementSelectionModelV1,
  GeometryProjectionV1,
  SelectionDerivationContextV1,
} from "../../../src/domain/geometry";
import { parseGroupId } from "../../../src/domain/model";
import {
  axesElement,
  elementLookup,
  FIXED_BINDING,
  identityProjection,
  lineElement,
  penElement,
  RANGE_BINDING,
  shapeElement,
  tableElement,
} from "./support";

function context(
  elements: Parameters<typeof elementLookup>[0],
  points: readonly { readonly x: number; readonly y: number }[] = [],
  projection: GeometryProjectionV1 = identityProjection,
): SelectionDerivationContextV1 {
  return {
    getElement: elementLookup(elements),
    getStrokePoints: () => points,
    projection,
  };
}

function valueOf(
  result: ReturnType<typeof deriveElementSelectionModelV1>,
): ElementSelectionModelV1 {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

describe("single-element selection models", () => {
  it("derives linear endpoints, attachment indicators, and curve handles", () => {
    const target = tableElement("1");
    const line = lineElement(
      "2",
      [{ targetElementId: target.elementId, portId: "area:west" }, null],
      { x: 4, y: -3 },
    );
    const before = structuredClone(line);
    const model = valueOf(
      deriveElementSelectionModelV1(line, context([line, target])),
    );
    expect(model.kind).toBe("linear");
    if (model.kind !== "linear") return;
    expect(model.endpoints).toEqual([
      { endpoint: "start", point: { x: 4, y: 20 }, attached: true },
      { endpoint: "end", point: { x: 8, y: 4 }, attached: false },
    ]);
    expect(model.attachmentIndicators).toEqual([model.endpoints[0]]);
    expect(model.curveHandle).toEqual({ x: 4, y: -3 });
    expect("frame" in model).toBe(false);
    expect(line).toEqual(before);
  });

  it("uses the midpoint as the straight Line and Arrow curve handle", () => {
    for (const kind of ["line", "arrow"] as const) {
      const element = { ...lineElement("1"), kind };
      const model = valueOf(
        deriveElementSelectionModelV1(element, context([element])),
      );
      expect(model.kind === "linear" && model.curveHandle).toEqual({
        x: 4,
        y: 2,
      });
    }
  });
});

describe("area selection models", () => {
  it("derives oriented area controls for every closed shape", () => {
    const angles = [-Math.PI, -0.2, 0, Math.PI / 4, Math.PI - 0.01];
    const kinds = [
      "rectangle",
      "ellipse",
      "triangle",
      "diamond",
      "octagon",
    ] as const;
    for (const [index, kind] of kinds.entries()) {
      for (const angle of angles) {
        const shape = shapeElement(kind, String(index + 1), {
          center: { x: 10, y: 20 },
          width: 12,
          height: 8,
          rotationRadians: angle,
        });
        const model = valueOf(
          deriveElementSelectionModelV1(shape, context([shape])),
        );
        expect(model.kind).toBe("area");
        if (model.kind !== "area") continue;
        expect(model.frame).toEqual(shape.geometry);
        expect(model.resizeHandles).toHaveLength(8);
        expect(model.resizeHandles.every((handle) => handle.enabled)).toBe(
          true,
        );
        expect(model.rotateHandle).not.toBeNull();
      }
    }
  });

  it("reconstructs rotated Stroke bounds and disables a zero sample axis", () => {
    const angle = Math.PI / 4;
    const frame = {
      center: { x: 20, y: 30 },
      width: 10,
      height: 4,
      rotationRadians: angle,
    };
    const points = [
      transformFramePointV1(frame, { x: -5, y: -2 }),
      transformFramePointV1(frame, { x: 5, y: 2 }),
    ];
    const pen = penElement("1", angle);
    const model = valueOf(
      deriveElementSelectionModelV1(pen, context([pen], points)),
    );
    expect(model.kind).toBe("area");
    if (model.kind !== "area") return;
    expect(model.frame.center.x).toBeCloseTo(20);
    expect(model.frame.center.y).toBeCloseTo(30);
    expect(model.frame.width).toBeCloseTo(10);
    expect(model.frame.height).toBeCloseTo(4);

    const vertical = penElement("2", 0);
    const verticalModel = valueOf(
      deriveElementSelectionModelV1(
        vertical,
        context(
          [vertical],
          [
            { x: 2, y: 1 },
            { x: 2, y: 9 },
          ],
        ),
      ),
    );
    expect(
      verticalModel.kind === "area" && verticalModel.disabledStrokeAxes,
    ).toEqual({ x: true, y: false });
    expect(
      verticalModel.kind === "area" &&
        verticalModel.resizeHandles.find((handle) => handle.id === "east")
          ?.enabled,
    ).toBe(false);
  });
});

describe("Table and range selection models", () => {
  it("derives Table dividers in stable row-then-column order", () => {
    const table = tableElement("1");
    const model = valueOf(
      deriveElementSelectionModelV1(table, context([table])),
    );
    expect(model.kind).toBe("area");
    if (model.kind !== "area") return;
    expect(
      model.dividerHandles.map(({ axis, index, point }) => ({
        axis,
        index,
        point,
      })),
    ).toEqual([
      { axis: "row", index: 0, point: { x: 10, y: 18 } },
      { axis: "row", index: 1, point: { x: 10, y: 21 } },
      { axis: "column", index: 0, point: { x: 7, y: 20 } },
      { axis: "column", index: 1, point: { x: 12, y: 20 } },
    ]);
    expect(model.dividerHandles[0]?.corridor).toEqual([
      { x: 4, y: 18 },
      { x: 16, y: 18 },
    ]);
  });

  it("keeps range-derived areas selectable without transform controls", () => {
    for (const element of [
      penElement("1", 0, RANGE_BINDING),
      shapeElement(
        "rectangle",
        "2",
        {
          center: { x: 0, y: 0 },
          width: 5,
          height: 6,
          rotationRadians: 0,
        },
        RANGE_BINDING,
      ),
      tableElement("3", RANGE_BINDING),
    ]) {
      const model = valueOf(
        deriveElementSelectionModelV1(
          element,
          context(
            [element],
            [
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ],
          ),
        ),
      );
      expect(model.kind).toBe("area");
      if (model.kind !== "area") continue;
      expect(model.resizeHandles).toEqual([]);
      expect(model.rotateHandle).toBeNull();
      expect(model.dividerHandles).toEqual([]);
      expect(model.geometryTransformAllowed).toBe(false);
    }
  });
});

describe("axis selection models", () => {
  it("derives one control corridor per axis and the X-axis angle", () => {
    for (const dimensions of ["2d", "3d"] as const) {
      const axes = axesElement(dimensions, dimensions === "2d" ? "1" : "2");
      const model = valueOf(
        deriveElementSelectionModelV1(axes, context([axes])),
      );
      expect(model.kind).toBe("axis-set");
      if (model.kind !== "axis-set") continue;
      expect(model.axes).toHaveLength(dimensions === "2d" ? 2 : 3);
      expect(model.axes.map((axis) => axis.axis)).toEqual(
        dimensions === "2d" ? ["x", "y"] : ["x", "y", "z"],
      );
      expect(model.moveTarget).toEqual({ x: 5, y: 7 });
      expect(model.rotateHandle).toEqual({ x: 9, y: 7 });
      expect(model.axes[0]?.controlBound).toEqual({
        center: { x: 7, y: 7 },
        length: 4,
        rotationRadians: -0,
      });
      expect(model.rotationRadians).toBeCloseTo(0);
      expect("frame" in model).toBe(false);
    }
  });
});

describe("aggregate selection models", () => {
  function memberModels(): readonly ElementSelectionModelV1[] {
    const shape = shapeElement("rectangle", "1", {
      center: { x: 0, y: 0 },
      width: 4,
      height: 2,
      rotationRadians: 0,
    });
    const line = lineElement("2");
    return [
      valueOf(deriveElementSelectionModelV1(shape, context([shape]))),
      valueOf(deriveElementSelectionModelV1(line, context([line]))),
    ];
  }

  it("uses persisted Group orientation and zero transient orientation", () => {
    const members = memberModels();
    const group = deriveAggregateSelectionModelV1({
      kind: "group",
      group: {
        groupId: parseGroupId(`grp_${"0".repeat(26)}`),
        childIds: members.map((member) => member.elementId),
        selectionRotationRadians: Math.PI / 4,
      },
      members,
    });
    const transient = deriveAggregateSelectionModelV1({
      kind: "multi-selection",
      members,
    });
    expect(group.ok && group.value.frame.rotationRadians).toBeCloseTo(
      Math.PI / 4,
    );
    expect(group.ok && group.value.persistedOrientation).toBe(true);
    expect(transient.ok && transient.value.frame.rotationRadians).toBe(0);
    expect(transient.ok && transient.value.persistedOrientation).toBe(false);
  });

  it("blocks the complete aggregate when one member is range-derived", () => {
    const fixed = shapeElement("rectangle", "1", {
      center: { x: 0, y: 0 },
      width: 4,
      height: 2,
      rotationRadians: 0,
    });
    const range = shapeElement("ellipse", "2", fixed.geometry, RANGE_BINDING);
    const members = [
      valueOf(deriveElementSelectionModelV1(fixed, context([fixed]))),
      valueOf(deriveElementSelectionModelV1(range, context([range]))),
    ];
    const aggregate = deriveAggregateSelectionModelV1({
      kind: "multi-selection",
      members,
    });
    expect(aggregate.ok).toBe(true);
    if (!aggregate.ok) return;
    expect(aggregate.value.geometryTransformAllowed).toBe(false);
    expect(aggregate.value.resizeHandles).toEqual([]);
    expect(aggregate.value.rotateHandle).toBeNull();
  });
});

describe("selection derivation failures", () => {
  it("fails closed for unavailable samples and invalid projections", () => {
    const pen = penElement("1", 0, FIXED_BINDING);
    expect(deriveElementSelectionModelV1(pen, context([pen]))).toEqual({
      ok: false,
      reason: "stroke-points-unavailable",
    });
    expect(
      deriveElementSelectionModelV1(
        pen,
        context([pen], [{ x: 0, y: 0 }], {
          ...identityProjection,
          projectStroke: () => [{ x: Number.NaN, y: 0 }],
        }),
      ),
    ).toEqual({ ok: false, reason: "projection-invalid" });
  });

  it("fails closed before projection for stale and non-invertible tokens", () => {
    const shape = shapeElement("rectangle", "1", {
      center: { x: 0, y: 0 },
      width: 1,
      height: 1,
      rotationRadians: 0,
    });
    expect(
      deriveElementSelectionModelV1(
        shape,
        context([shape], [], {
          ...identityProjection,
          token: { availability: "stale", invertible: true },
        }),
      ),
    ).toEqual({ ok: false, reason: "projection-stale" });
    expect(
      deriveElementSelectionModelV1(
        shape,
        context([shape], [], {
          ...identityProjection,
          token: { availability: "current", invertible: false },
        }),
      ),
    ).toEqual({ ok: false, reason: "projection-non-invertible" });
  });

  it("rejects an empty aggregate", () => {
    const failure = deriveAggregateSelectionModelV1({
      kind: "multi-selection",
      members: [],
    });
    expect(failure).toEqual({ ok: false, reason: "selection-empty" });
    expect(Object.isFrozen(failure)).toBe(true);
    expect(Reflect.set(failure, "reason", "projection-invalid")).toBe(false);
  });
});

describe("selection output immutability", () => {
  it("deeply freezes linear and area models", () => {
    const line = lineElement("1", [null, null], { x: 2, y: 3 });
    const linear = deriveElementSelectionModelV1(line, context([line]));
    expect(linear.ok).toBe(true);
    if (!linear.ok || linear.value.kind !== "linear") return;
    expect(Object.isFrozen(linear)).toBe(true);
    expect(Object.isFrozen(linear.value)).toBe(true);
    expect(Object.isFrozen(linear.value.endpoints)).toBe(true);
    expect(Object.isFrozen(linear.value.endpoints[0])).toBe(true);
    expect(Object.isFrozen(linear.value.endpoints[0].point)).toBe(true);
    expect(Object.isFrozen(linear.value.curveHandle)).toBe(true);
    expect(Object.isFrozen(linear.value.attachmentIndicators)).toBe(true);
    expect(Object.isFrozen(linear.value.anchorHandle)).toBe(true);
    expect(Object.isFrozen(linear.value.anchorHandle.point)).toBe(true);
    expect(Reflect.set(linear.value.curveHandle, "x", 99)).toBe(false);
    expect(Object.isFrozen(line)).toBe(false);
    expect(Object.isFrozen(line.geometry)).toBe(false);

    const table = tableElement("2");
    const area = deriveElementSelectionModelV1(table, context([table]));
    expect(area.ok).toBe(true);
    if (!area.ok || area.value.kind !== "area") return;
    expect(Object.isFrozen(area)).toBe(true);
    expect(Object.isFrozen(area.value)).toBe(true);
    expect(Object.isFrozen(area.value.frame)).toBe(true);
    expect(Object.isFrozen(area.value.frame.center)).toBe(true);
    expect(Object.isFrozen(area.value.resizeHandles)).toBe(true);
    expect(Object.isFrozen(area.value.resizeHandles[0])).toBe(true);
    expect(Object.isFrozen(area.value.resizeHandles[0]?.point)).toBe(true);
    expect(Object.isFrozen(area.value.rotateHandle)).toBe(true);
    expect(Object.isFrozen(area.value.dividerHandles)).toBe(true);
    expect(Object.isFrozen(area.value.dividerHandles[0])).toBe(true);
    expect(Object.isFrozen(area.value.dividerHandles[0]?.point)).toBe(true);
    expect(Object.isFrozen(area.value.dividerHandles[0]?.corridor)).toBe(true);
    expect(Object.isFrozen(area.value.dividerHandles[0]?.corridor[0])).toBe(
      true,
    );
    expect(Object.isFrozen(area.value.disabledStrokeAxes)).toBe(true);
    expect(Object.isFrozen(area.value.anchorHandle)).toBe(true);
    expect(Object.isFrozen(area.value.anchorHandle.point)).toBe(true);
    expect(Reflect.set(area.value.frame.center, "x", 99)).toBe(false);
    expect(Object.isFrozen(table)).toBe(false);
    expect(Object.isFrozen(table.geometry)).toBe(false);
  });

  it("deeply freezes axis-set and aggregate models", () => {
    const axes = axesElement("3d", "1");
    const axisSet = deriveElementSelectionModelV1(axes, context([axes]));
    expect(axisSet.ok).toBe(true);
    if (!axisSet.ok || axisSet.value.kind !== "axis-set") return;
    expect(Object.isFrozen(axisSet)).toBe(true);
    expect(Object.isFrozen(axisSet.value)).toBe(true);
    expect(Object.isFrozen(axisSet.value.axes)).toBe(true);
    expect(Object.isFrozen(axisSet.value.axes[0])).toBe(true);
    expect(Object.isFrozen(axisSet.value.axes[0]?.start)).toBe(true);
    expect(Object.isFrozen(axisSet.value.axes[0]?.end)).toBe(true);
    expect(Object.isFrozen(axisSet.value.axes[0]?.lengthHandle)).toBe(true);
    expect(Object.isFrozen(axisSet.value.axes[0]?.controlBound)).toBe(true);
    expect(Object.isFrozen(axisSet.value.axes[0]?.controlBound.center)).toBe(
      true,
    );
    expect(Object.isFrozen(axisSet.value.anchorHandle)).toBe(true);
    expect(Object.isFrozen(axisSet.value.anchorHandle.point)).toBe(true);
    expect(Object.isFrozen(axisSet.value.moveTarget)).toBe(true);
    expect(Object.isFrozen(axisSet.value.rotateHandle)).toBe(true);
    expect(Reflect.set(axisSet.value.axes, "0", null)).toBe(false);

    const aggregate = deriveAggregateSelectionModelV1({
      kind: "multi-selection",
      members: [axisSet.value],
    });
    expect(aggregate.ok).toBe(true);
    if (!aggregate.ok) return;
    expect(Object.isFrozen(aggregate)).toBe(true);
    expect(Object.isFrozen(aggregate.value)).toBe(true);
    expect(Object.isFrozen(aggregate.value.frame)).toBe(true);
    expect(Object.isFrozen(aggregate.value.frame.center)).toBe(true);
    expect(Object.isFrozen(aggregate.value.resizeHandles)).toBe(true);
    expect(Object.isFrozen(aggregate.value.resizeHandles[0])).toBe(true);
    expect(Object.isFrozen(aggregate.value.resizeHandles[0]?.point)).toBe(true);
    expect(Object.isFrozen(aggregate.value.rotateHandle)).toBe(true);
    expect(Object.isFrozen(aggregate.value.anchorHandle)).toBe(true);
    expect(Reflect.set(aggregate.value.frame, "width", 0)).toBe(false);
  });
});
