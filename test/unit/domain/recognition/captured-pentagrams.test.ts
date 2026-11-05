import { describe, expect, it } from "vitest";
import { capturedPentagramStroke } from "../../../fixtures/domain/captured-pentagrams";
import { capturedRecognitionStroke } from "../../../fixtures/domain/captured-recognition";
import { recognizeSamples } from "./recognition-fixtures";

describe("recorded five-tip crossing gestures", () => {
  it.each([79, 80])(
    "recognizes uneven pentagram %s in both directions and supported zooms",
    (index) => {
      const samples = capturedPentagramStroke(index);
      const reversed = Array.from({ length: samples.length / 3 }, (_, offset) =>
        samples.slice(samples.length - (offset + 1) * 3, samples.length - offset * 3),
      ).flat();
      for (const zoom of [0.5, 1, 2]) {
        for (const points of [samples, reversed]) {
          expect(recognizeSamples(points, zoom)?.kind, `stroke ${index} at zoom ${zoom}`).toBe(
            "star",
          );
        }
      }
    },
  );

  it.each([26, 29])("keeps unrelated recorded hook or crossed swoosh %s raw", (index) => {
    expect(recognizeSamples(capturedRecognitionStroke(index))).toBeNull();
  });
});
