import { describe, expect, it } from "vitest";

import { centeredGuideAxis } from "../../../../src/domain/geometry/public";

describe("centered background guides", () => {
  it("fits only complete intervals and splits the unused space equally", () => {
    expect(centeredGuideAxis(24.3, 2000, 60)).toEqual({
      end: 2014.3,
      intervalCount: 33,
      start: 34.3,
    });
  });

  it("collapses at the center when no complete interval fits", () => {
    expect(centeredGuideAxis(10, 30, 40)).toEqual({
      end: 25,
      intervalCount: 0,
      start: 25,
    });
  });
});
