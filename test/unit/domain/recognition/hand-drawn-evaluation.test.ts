import { describe, expect, it } from "vitest";
import {
  ambiguousRecognitionExamples,
  nativeCurveOverlapExample,
  recognitionCorpus,
} from "../../../fixtures/domain/hand-drawn-recognition/corpus";
import { expectRecognitionExample, recognizeSamples } from "./recognition-fixtures";

describe("frozen independent hand-drawn evaluation", () => {
  it.each(recognitionCorpus("evaluation"))("$id: $variation", (example) =>
    expectRecognitionExample(example),
  );

  it.each(ambiguousRecognitionExamples())("keeps $id raw: $variation", (example) => {
    expect(recognizeSamples(example.samples)).toBeNull();
  });

  it("recognizes a supported quadratic even when the same ink resembles a broad J", () => {
    expectRecognitionExample(nativeCurveOverlapExample());
  });
});
