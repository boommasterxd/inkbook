import { describe, expect, it } from "vitest";

import {
  CANONICAL_BACKGROUND_SPACINGS,
  type BackgroundV1,
} from "../../../../src/domain/schema/public";

describe("canonical background spacing", () => {
  it("uses one shared absolute size series for every patterned background", () => {
    expect(CANONICAL_BACKGROUND_SPACINGS).toEqual([25, 33.333333333333336, 50, 100]);
    for (const type of ["lines", "dots", "squares"] as const) {
      for (const spacing of CANONICAL_BACKGROUND_SPACINGS) {
        const background = { type, spacing } satisfies Exclude<BackgroundV1, { type: "none" }>;
        expect(background.spacing).toBe(spacing);
      }
    }
  });
});
