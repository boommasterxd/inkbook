import { expect, it } from "vitest";
import {
  matchFontFace,
  type FontFaceDescriptor,
} from "../../../../src/domain/text/font-face-matching";

const family = `custom-${"a".repeat(64)}`;
const regular: FontFaceDescriptor = { family, weight: 400, style: "normal" };
const bold: FontFaceDescriptor = { family, weight: 700, style: "normal" };

it("prefers real style/weight faces and preserves strict lookup for new font admission", () => {
  expect(matchFontFace([regular, bold], { family, weight: 700, style: "normal" })).toBe(bold);
  expect(matchFontFace([regular], { family, weight: 700, style: "normal" }, false)).toBeUndefined();
  expect(matchFontFace([regular, bold], { family, weight: 700, style: "italic" })).toBe(bold);
});

it("uses a single Medium face for normal, bold and italic without relabeling its metrics", () => {
  const medium = { family, weight: 500, style: "normal" as const };
  for (const request of [
    { family, weight: 400, style: "normal" as const },
    { family, weight: 700, style: "normal" as const },
    { family, weight: 700, style: "italic" as const },
  ]) {
    expect(matchFontFace([medium], request)).toBe(medium);
  }
  expect(medium).toEqual({ family, weight: 500, style: "normal" });
});

it("applies CSS's 400/500 ordering, style precedence and variable ranges", () => {
  const light = { family, weight: 300, style: "normal" as const };
  const medium = { family, weight: 500, style: "normal" as const };
  const italic = { family, weight: 300, style: "italic" as const };
  expect(matchFontFace([light, medium], { family, weight: 400, style: "normal" })).toBe(medium);
  expect(matchFontFace([regular, italic], { family, weight: 700, style: "italic" })).toBe(italic);
  const variable = { ...regular, weightRange: [400, 700] as const };
  expect(matchFontFace([variable], { family, weight: 700, style: "normal" })).toBe(variable);
});

it("keeps unrelated families and missing builtin faces unavailable", () => {
  expect(
    matchFontFace([regular], { family: "inter", weight: 400, style: "normal" }),
  ).toBeUndefined();
  expect(
    matchFontFace([{ ...regular, family: "inter" }], {
      family: "inter",
      weight: 700,
      style: "italic",
    }),
  ).toBeUndefined();
});
