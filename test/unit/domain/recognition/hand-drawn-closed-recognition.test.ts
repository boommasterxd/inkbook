import { describe, it } from "vitest";
import { ellipseDevelopmentExamples } from "../../../fixtures/domain/hand-drawn-recognition/ellipse-development";
import { polygonDevelopmentExamples } from "../../../fixtures/domain/hand-drawn-recognition/polygon-development";
import { expectRecognitionExample } from "./recognition-fixtures";

describe("independently authored closed-shape development traces", () => {
  it.each([...polygonDevelopmentExamples(), ...ellipseDevelopmentExamples()])("$id", (example) => {
    expectRecognitionExample(example);
  });
});
