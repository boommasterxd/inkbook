import { expect, it } from "vitest";
import { sharedAutoContrastBox } from "../../../../src/domain/images/auto-contrast";

it("shares an overlapping tile for small regions crossing the world grid", () => {
  const first = sharedAutoContrastBox({
    minX: 31.9994,
    minY: 63.9994,
    maxX: 41.9994,
    maxY: 68.9994,
  });
  const nearby = sharedAutoContrastBox({ minX: 20, minY: 40, maxX: 30, maxY: 45 });
  expect(first).toEqual({ minX: 0, minY: 32, maxX: 64, maxY: 96 });
  expect(first).toEqual(nearby);
});

it("contains outward-rounded transformed bounds at negative and far-page positions", () => {
  const source = { minX: -0.0004, minY: 999_983.9994, maxX: 12.3456, maxY: 999_999.9998 };
  const box = sharedAutoContrastBox(source);
  expect(box).toEqual({ minX: -32, minY: 999_968, maxX: 32, maxY: 1_000_032 });
  expect(box.minX).toBeLessThanOrEqual(source.minX);
  expect(box.minY).toBeLessThanOrEqual(source.minY);
  expect(box.maxX).toBeGreaterThanOrEqual(source.maxX);
  expect(box.maxY).toBeGreaterThanOrEqual(source.maxY);
});

it("retains the bounded adaptive region for larger paint geometry", () => {
  expect(
    sharedAutoContrastBox({ minX: 100.0004, minY: 0.0004, maxX: 180.0003, maxY: 2048 }),
  ).toEqual({
    minX: 100,
    minY: 0,
    maxX: 180.001,
    maxY: 2048,
  });
});

it("admits a larger overlapping tile only when the caller supplies its zoom-derived stride", () => {
  const bounds = { minX: 140, minY: 260, maxX: 240, maxY: 350 };
  expect(sharedAutoContrastBox(bounds)).toEqual(bounds);
  expect(sharedAutoContrastBox(bounds, 128)).toEqual({
    minX: 128,
    minY: 256,
    maxX: 384,
    maxY: 512,
  });
});
