import { describe, expect, it } from "vitest";
import {
  verificationNegativeExamples,
  verificationRecognitionExamples,
} from "../../../fixtures/domain/hand-drawn-recognition/verification";
import { expectRecognitionExample, recognizeSamples } from "./recognition-fixtures";

describe("fresh frozen recognition verification", () => {
  it.each(verificationRecognitionExamples())("$id: $variation", (example) => {
    expectRecognitionExample(example);
  });

  it.each(verificationNegativeExamples())("keeps $id raw: $variation", (example) => {
    expect(recognizeSamples(example.samples)).toBeNull();
  });
});
