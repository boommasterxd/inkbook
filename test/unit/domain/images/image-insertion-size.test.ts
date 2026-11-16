import { expect, it } from "vitest";
import { initialImageSize } from "../../../../src/domain/images/image-insertion-size";

it.each([
  { width: 2000, height: 2000, expected: { width: 800, height: 800 } },
  { width: 1000, height: 4000, expected: { width: 200, height: 800 } },
  { width: 400, height: 200, expected: { width: 400, height: 200 } },
])(
  "fits a $width by $height image into the compact insertion box without enlargement",
  ({ width, height, expected }) => {
    expect(initialImageSize({ width, height }, 2000, "image")).toEqual(expected);
  },
);

it("leaves fractional dimensions for canonical placement rounding", () => {
  const size = initialImageSize({ width: 3000, height: 1000 }, 2000, "image");
  expect(size.width).toBe(800);
  expect(size.height).toBeCloseTo(800 / 3, 12);
  expect(size.width / size.height).toBeCloseTo(3, 12);
});

it("keeps tall PDF pages at writing width without a compact height limit", () => {
  const resource = { width: 1000, height: 4000 };
  expect(initialImageSize(resource, 2000, "pdf")).toEqual({ width: 1000, height: 4000 });
});

it.each(["image", "pdf"] as const)(
  "fits a small %s source to the full writing width only when explicitly requested",
  (source) => {
    const resource = { width: 100, height: 200 };
    expect(initialImageSize(resource, 2000, source, "page-width-locked")).toEqual({
      width: 2000,
      height: 4000,
    });
    expect(initialImageSize(resource, 2000, source, "default")).toEqual(resource);
  },
);
