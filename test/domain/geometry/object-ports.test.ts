/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact geometry fixtures and expectations. */

import { describe, expect, it } from "vitest";

import type { GeometryProjectionV1 } from "../../../src/domain/geometry";
import type { ObjectPortIdV1, SceneElementV1 } from "../../../src/domain/model";
import {
  resolveLinearEndpointsV1,
  resolveObjectPortV1,
} from "../../../src/domain/geometry";
import {
  axesElement,
  elementId,
  elementLookup,
  identityProjection,
  lineElement,
  penElement,
  RANGE_BINDING,
  shapeElement,
  tableElement,
  translatedProjection,
} from "./support";

function resolve(
  target: SceneElementV1,
  portId: ObjectPortIdV1,
  projection: GeometryProjectionV1 = identityProjection,
): ReturnType<typeof resolveObjectPortV1> {
  return resolveObjectPortV1({
    attachment: { targetElementId: target.elementId, portId },
    getElement: elementLookup([target]),
    projection,
  });
}

describe("object port resolution", () => {
  it("resolves every area port on every supported closed target", () => {
    const kinds = [
      "rectangle",
      "ellipse",
      "triangle",
      "diamond",
      "octagon",
    ] as const;
    for (const [index, kind] of kinds.entries()) {
      const target = shapeElement(kind, String(index + 1), {
        center: { x: 10, y: 20 },
        width: 12,
        height: 8,
        rotationRadians: 0,
      });
      const eastX = kind === "triangle" ? 13 : 16;
      expect(resolve(target, "area:north")).toEqual({
        ok: true,
        value: { x: 10, y: 16 },
      });
      expect(resolve(target, "area:east")).toEqual({
        ok: true,
        value: { x: eastX, y: 20 },
      });
      expect(resolve(target, "area:south")).toEqual({
        ok: true,
        value: { x: 10, y: 24 },
      });
      expect(resolve(target, "area:west")).toEqual({
        ok: true,
        value: { x: 20 - eastX, y: 20 },
      });
    }
    expect(resolve(tableElement("6"), "area:east")).toEqual({
      ok: true,
      value: { x: 16, y: 20 },
    });
  });

  it("uses exact rotation and current view-local enclosure geometry", () => {
    const target = shapeElement("rectangle", "1", {
      center: { x: 10, y: 20 },
      width: 12,
      height: 8,
      rotationRadians: Math.PI / 2,
    });
    const rangeTarget = shapeElement(
      "ellipse",
      "2",
      target.geometry,
      RANGE_BINDING,
    );
    const enclosureProjection: GeometryProjectionV1 = {
      ...identityProjection,
      projectArea: () => ({
        center: { x: 100, y: 200 },
        width: 40,
        height: 10,
        rotationRadians: 0,
      }),
    };

    const rotated = resolve(target, "area:east");
    expect(rotated.ok && rotated.value.x).toBeCloseTo(10);
    expect(rotated.ok && rotated.value.y).toBeCloseTo(14);
    expect(resolve(rangeTarget, "area:north", enclosureProjection)).toEqual({
      ok: true,
      value: { x: 100, y: 195 },
    });
  });
});

describe("axes and endpoint port resolution", () => {
  it("resolves every axes port and rejects the absent 2D Z port", () => {
    const axes2d = axesElement("2d", "1");
    const axes3d = axesElement("3d", "2");
    expect(resolve(axes2d, "axes:origin")).toEqual({
      ok: true,
      value: { x: 5, y: 7 },
    });
    expect(resolve(axes2d, "axes:x-positive")).toEqual({
      ok: true,
      value: { x: 9, y: 7 },
    });
    expect(resolve(axes2d, "axes:y-positive")).toEqual({
      ok: true,
      value: { x: 5, y: 4 },
    });
    expect(resolve(axes3d, "axes:z-positive")).toEqual({
      ok: true,
      value: { x: 3, y: 9 },
    });
    expect(resolve(axes2d, "axes:z-positive")).toEqual({
      ok: false,
      reason: "port-incompatible",
    });
  });

  it("rejects missing, incompatible, Line, and Stroke targets", () => {
    const rectangle = shapeElement("rectangle", "1", {
      center: { x: 0, y: 0 },
      width: 2,
      height: 2,
      rotationRadians: 0,
    });
    expect(resolve(rectangle, "axes:origin")).toEqual({
      ok: false,
      reason: "target-kind-unsupported",
    });
    expect(resolve(lineElement("2"), "area:north")).toEqual({
      ok: false,
      reason: "target-kind-unsupported",
    });
    expect(resolve(penElement("3", 0), "area:north")).toEqual({
      ok: false,
      reason: "target-kind-unsupported",
    });
    expect(
      resolveObjectPortV1({
        attachment: {
          targetElementId: elementId("4"),
          portId: "area:north",
        },
        getElement: () => undefined,
        projection: identityProjection,
      }),
    ).toEqual({ ok: false, reason: "target-not-found" });
  });

  it.each([
    ["stale", true, "projection-stale"],
    ["ambiguous", true, "projection-ambiguous"],
    ["unavailable", true, "projection-unavailable"],
    ["current", false, "projection-non-invertible"],
  ] as const)(
    "fails closed for %s projection tokens",
    (availability, invertible, reason) => {
      const target = tableElement("1");
      expect(
        resolve(target, "area:north", {
          ...identityProjection,
          token: { availability, invertible },
        }),
      ).toEqual({ ok: false, reason });
    },
  );

  it("projects free endpoints through their owner and replaces attachments", () => {
    const target = tableElement("1");
    const line = lineElement("2", [
      { targetElementId: target.elementId, portId: "area:east" },
      null,
    ]);
    const before = structuredClone(line);
    expect(
      resolveLinearEndpointsV1({
        element: line,
        getElement: elementLookup([line, target]),
        projection: translatedProjection(2, 3),
      }),
    ).toEqual({
      ok: true,
      value: { start: { x: 18, y: 23 }, end: { x: 10, y: 7 } },
    });
    expect(line).toEqual(before);
  });
});

describe("port output immutability", () => {
  it("deeply freezes port, endpoint, and failure results", () => {
    const target = tableElement("1");
    const port = resolve(target, "area:east");
    expect(port.ok).toBe(true);
    if (!port.ok) return;
    expect(Object.isFrozen(port)).toBe(true);
    expect(Object.isFrozen(port.value)).toBe(true);
    expect(Reflect.set(port.value, "x", 0)).toBe(false);
    expect(Object.isFrozen(target)).toBe(false);
    expect(Object.isFrozen(target.geometry)).toBe(false);

    const line = lineElement("2");
    const endpoints = resolveLinearEndpointsV1({
      element: line,
      getElement: elementLookup([line]),
      projection: identityProjection,
    });
    expect(endpoints.ok).toBe(true);
    if (!endpoints.ok) return;
    expect(Object.isFrozen(endpoints)).toBe(true);
    expect(Object.isFrozen(endpoints.value)).toBe(true);
    expect(Object.isFrozen(endpoints.value.start)).toBe(true);
    expect(Object.isFrozen(endpoints.value.end)).toBe(true);
    expect(Reflect.set(endpoints.value.start, "x", 99)).toBe(false);
    expect(Object.isFrozen(line)).toBe(false);
    expect(Object.isFrozen(line.geometry)).toBe(false);

    const failure = resolve(target, "axes:origin");
    expect(failure).toEqual({
      ok: false,
      reason: "target-kind-unsupported",
    });
    expect(Object.isFrozen(failure)).toBe(true);
    expect(Reflect.set(failure, "reason", "projection-invalid")).toBe(false);
  });
});
