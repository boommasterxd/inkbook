import { describe, expect, it } from "vitest";
import { capturedRecognitionStroke } from "../../../fixtures/domain/captured-recognition";
import { recognizeSamples, transformSamples } from "./recognition-fixtures";

function recognize(index: number, reverse = false) {
  return recognizeSamples(transformSamples(capturedRecognitionStroke(index), 37, reverse));
}

describe("captured open lines and arches", () => {
  it.each([1, 13])("straightens a gentle bow despite final hold jitter in stroke %s", (index) => {
    for (const reverse of [false, true])
      expect(recognize(index, reverse)).toMatchObject({ kind: "line", bend: null });
  });

  it.each([0, 16, 17, 19, 49])("retains the visible arch of stroke %s", (index) => {
    for (const reverse of [false, true]) {
      const result = recognize(index, reverse);
      expect(result?.kind).toBe("line");
      expect(result && "bend" in result ? result.bend : null).not.toBeNull();
    }
  });

  it.each([26, 29, 48])("keeps a hook, loop or overhanging arch raw in stroke %s", (index) => {
    expect(recognize(index)).toBeNull();
  });
});
