import { expect, it } from "vitest";
import {
  inlineTextHeight,
  inlineTextRectangle,
  localEditorMatrix,
} from "../../../../../src/obsidian/text/editor/text-background-coordinates";
import type { TextEditingMatrix } from "../../../../../src/rendering/scene/text-editing-geometry";

/** DOMMatrix exposes its geometry through inherited, non-enumerable accessors. */
class NativeMatrix implements TextEditingMatrix {
  public constructor(private readonly value: TextEditingMatrix) {}
  public get a() {
    return this.value.a;
  }
  public get b() {
    return this.value.b;
  }
  public get c() {
    return this.value.c;
  }
  public get d() {
    return this.value.d;
  }
  public get e() {
    return this.value.e;
  }
  public get f() {
    return this.value.f;
  }
}

function rectangle(
  matrix: TextEditingMatrix,
  box: { x: number; y: number; width: number; height: number },
) {
  const points = [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x + box.width, box.y + box.height],
    [box.x, box.y + box.height],
  ];
  const xs = points.map(([x, y]) => matrix.a * x! + matrix.c * y! + matrix.e);
  const ys = points.map(([x, y]) => matrix.b * x! + matrix.d * y! + matrix.f);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

it.each([0, 45, 90, 135])(
  "recovers native inline boxes and the editor origin at %s degrees",
  (angle) => {
    const radians = (angle * Math.PI) / 180;
    const matrix = {
      a: Math.cos(radians) * 0.5,
      b: Math.sin(radians) * 0.5,
      c: -Math.sin(radians) * 0.5,
      d: Math.cos(radians) * 0.5,
      e: 120,
      f: 200,
    };
    const box = { x: 20, y: 30, width: 60, height: 53 };
    const collapsed = rectangle(matrix, { ...box, width: 0 });
    const height = inlineTextHeight(collapsed, matrix)!;
    expect(height).toBeCloseTo(53, 10);
    const local = localEditorMatrix(
      rectangle(matrix, { x: 0, y: 0, width: 100, height: 300 }),
      new NativeMatrix(matrix),
      100,
      300,
    );
    const result = inlineTextRectangle(rectangle(matrix, box), local, height)!;
    for (const key of ["x", "y", "width", "height"] as const)
      expect(result[key]).toBeCloseTo(box[key], 10);
    expect(local.e).toBeCloseTo(matrix.e, 10);
    expect(local.f).toBeCloseTo(matrix.f, 10);
  },
);

it("does not publish nonfinite or singular native geometry", () => {
  const matrix = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 };
  const box = { left: 0, right: 0, top: 0, bottom: 10 };
  expect(inlineTextHeight(box, matrix)).toBeUndefined();
  expect(inlineTextRectangle(box, matrix, 10)).toBeUndefined();
  expect(inlineTextRectangle(box, { ...matrix, a: 1, d: 1 }, NaN)).toBeUndefined();
});
