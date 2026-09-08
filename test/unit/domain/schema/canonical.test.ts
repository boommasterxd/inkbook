import { describe, expect, it } from "vitest";

import {
  canonicalizeGeometryNumber,
  canonicalizeUnitIntervalNumber,
  isCanonicalGeometryNumber,
  isCanonicalUnitIntervalNumber,
  isRgbaColor,
  PORTABLE_PALETTE_V1,
} from "../../../../src/domain/schema/public";
import {
  canonicalizeRotation,
  isCanonicalRotation,
  isLowercaseUuidV4,
} from "../../../../src/domain/schema/canonical";

describe("schema canonical values", () => {
  it("canonicalizes geometry, unit values, rotation, and negative zero", () => {
    expect(canonicalizeGeometryNumber(1.2346)).toBe(1.235);
    expect(canonicalizeUnitIntervalNumber(0.12346)).toBe(0.1235);
    expect(canonicalizeGeometryNumber(-0)).toBe(0);
    expect(canonicalizeRotation(180)).toBe(-180);
    expect(canonicalizeRotation(540)).toBe(-180);
  });

  it("recognizes canonical numeric forms and rejects invalid values", () => {
    expect(isCanonicalGeometryNumber(1.234)).toBe(true);
    expect(isCanonicalGeometryNumber(1.2345)).toBe(false);
    expect(isCanonicalGeometryNumber(-0)).toBe(false);
    expect(isCanonicalUnitIntervalNumber(0.1234)).toBe(true);
    expect(isCanonicalUnitIntervalNumber(1.0001)).toBe(false);
    expect(isCanonicalRotation(-180)).toBe(true);
    expect(isCanonicalRotation(180)).toBe(false);
    expect(isCanonicalRotation(-180.001)).toBe(false);
    expect(isCanonicalRotation(179.9995)).toBe(false);
    expect(isCanonicalRotation(Number.NaN)).toBe(false);
    expect(() => canonicalizeGeometryNumber(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("accepts every three-decimal rotation across the complete canonical range", () => {
    let firstFailure: { readonly canonical: number; readonly value: number } | null = null;
    for (let millidegrees = -180_000; millidegrees < 180_000; millidegrees += 1) {
      const value = millidegrees / 1000;
      const canonical = canonicalizeRotation(value);
      if (!Object.is(canonical, value) || !isCanonicalRotation(value)) {
        firstFailure ??= { canonical, value };
      }
    }

    expect(firstFailure).toBeNull();
  });

  it("validates lowercase UUID v4 and exact uppercase RGBA values", () => {
    expect(isLowercaseUuidV4("00000000-0000-4000-8000-000000000001")).toBe(true);
    expect(isLowercaseUuidV4("00000000-0000-5000-8000-000000000001")).toBe(false);
    expect(isLowercaseUuidV4("00000000-0000-4000-A000-000000000001")).toBe(false);
    expect(isRgbaColor("#AABBCCDD")).toBe(true);
    expect(isRgbaColor("#aabbccdd")).toBe(false);
    expect(isRgbaColor("#AABBCC")).toBe(false);
  });

  it("exposes the fixed portable palette", () => {
    expect(PORTABLE_PALETTE_V1.light).toEqual({
      page: "#F6F6F6FF",
      text: "#222222FF",
      guide: "#ABABAB40",
    });
    expect(PORTABLE_PALETTE_V1.dark.page).toBe("#212121FF");
    expect(PORTABLE_PALETTE_V1.dark.guide).toBe("#66666640");
    expect(PORTABLE_PALETTE_V1.dark.text).toBe("#DADADAFF");
  });
});
