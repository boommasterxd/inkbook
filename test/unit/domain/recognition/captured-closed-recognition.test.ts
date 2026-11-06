import { describe, expect, it } from "vitest";
import { capturedRecognitionStroke } from "../../../fixtures/domain/captured-recognition";
import { recognizeSamples } from "./recognition-fixtures";

function recognize(index: number) {
  return recognizeSamples(capturedRecognitionStroke(index));
}

describe("recorded closed pen contours", () => {
  it.each([8, 9, 12])("fits all four sides of rough rectangle %s", (index) => {
    expect(recognize(index)?.kind).toBe("rectangle");
  });

  it("recognizes a smooth circle despite a short closing hook and a nearby octagon fit", () => {
    expect(recognize(11)?.kind).toBe("ellipse");
  });

  it.each([24, 28, 30])("fits the native triangle contour of recorded outline %s", (index) => {
    expect(recognize(index)?.kind).toBe("triangle");
  });

  it.each([26, 29])("keeps unrelated open hook or crossed swoosh %s raw", (index) => {
    expect(recognize(index)).toBeNull();
  });

  it.each([10, 21, 46])(
    "never turns unresolved closed outline %s into a shaft or arrow",
    (index) => {
      expect(["line", "arrow"]).not.toContain(recognize(index)?.kind);
    },
  );
});
