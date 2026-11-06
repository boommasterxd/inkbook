import { describe, expect, it } from "vitest";
import { ellipseDevelopmentExamples } from "../../../fixtures/domain/hand-drawn-recognition/ellipse-development";
import { polygonDevelopmentExamples } from "../../../fixtures/domain/hand-drawn-recognition/polygon-development";
import { expectRecognitionExample, recognizeSamples } from "./recognition-fixtures";

describe("independently authored closed-shape development traces", () => {
  it.each([...polygonDevelopmentExamples(), ...ellipseDevelopmentExamples()])("$id", (example) => {
    expectRecognitionExample(example);
  });

  it("retains a valid wavy ellipse when an axis-nearer fit exceeds the maximum error", () => {
    const rotation = 5.483224962977693;
    const cosine = Math.cos(rotation);
    const sine = Math.sin(rotation);
    const samples = Array.from({ length: 121 }, (_, index) => {
      const angle = (index * 2 * Math.PI) / 120 + 2.9174251157045368;
      const radius = 1 + (9.2532021808438 / 100) * Math.sin(5 * angle);
      const x = 143.073303187266 * radius * Math.cos(angle);
      const y = 125.02664294559509 * radius * Math.sin(angle);
      return [x * cosine - y * sine, x * sine + y * cosine, 0.5];
    }).flat();

    expect(recognizeSamples(samples)?.kind).toBe("ellipse");
  });
});
