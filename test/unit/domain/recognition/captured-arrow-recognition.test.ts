import { describe, expect, it } from "vitest";
import { capturedRecognitionStroke } from "../../../fixtures/domain/captured-recognition";
import { recognizeSamples } from "./recognition-fixtures";

function recognize(index: number, reverse = false) {
  const samples = capturedRecognitionStroke(index);
  const triples = Array.from({ length: samples.length / 3 }, (_, position) =>
    samples.slice(position * 3, position * 3 + 3),
  );
  return recognizeSamples((reverse ? triples.reverse() : triples).flat());
}

describe("captured handwritten arrow tips", () => {
  it.each([14, 31, 32, 34, 35, 41, 43, 44, 45])(
    "recognizes captured arrow %i with an offset return to the tip in either order",
    (index) => {
      for (const reverse of [false, true])
        expect(recognize(index, reverse)).toMatchObject({
          kind: "arrow",
          startNode: reverse ? "arrow" : "none",
          endNode: reverse ? "none" : "arrow",
        });
    },
  );

  it.each([37, 40])("keeps captured single-hook contour %i ambiguous", (index) => {
    expect(recognize(index)?.kind).not.toBe("arrow");
  });

  it.each([61, 67])("keeps unsupported box endpoint %i as ink in either order", (index) => {
    for (const reverse of [false, true]) expect(recognize(index, reverse)).toBeNull();
  });
});
