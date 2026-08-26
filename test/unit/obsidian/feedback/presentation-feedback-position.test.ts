import { describe, expect, it } from "vitest";

import { resolvePresentationFeedbackPosition } from "../../../../src/obsidian/feedback";

describe("presentation feedback position", () => {
  it("uses the lower center of the visible embed and native-scroll intersection", () => {
    expect(
      resolvePresentationFeedbackPosition(
        { bottom: 1_500, left: 100, right: 1_100, top: -400 },
        { bottom: 900, left: 0, right: 1_200, top: 100 },
      ),
    ).toEqual({ bottom: 616, left: 500, maxInlineSize: 976, visible: true });
  });

  it("hides feedback after the presentation leaves the visible scroll owner", () => {
    expect(
      resolvePresentationFeedbackPosition(
        { bottom: 2_000, left: 200, right: 1_000, top: 1_000 },
        { bottom: 900, left: 0, right: 1_200, top: 100 },
      ).visible,
    ).toBe(false);
  });
});
