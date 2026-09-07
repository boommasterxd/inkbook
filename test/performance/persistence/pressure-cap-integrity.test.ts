import { describe, expect, it } from "vitest";

import {
  serializeElementPaths,
  serializeLegacyPressurePath,
} from "../../../src/persistence/serialization/path-markup";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import { StreamingStaticIntegrityMatcher } from "../../../src/persistence/serialization/streaming-static-integrity";
import { createStandardPersistenceFixture } from "./fixtures";
import { annotateDurations, expectProfileBudget, measure } from "./metrics";

describe("pressure-cap static integrity performance", () => {
  it("matches current and legacy caps for 10,000 pressure strokes within the unlock budget", async ({
    annotate,
  }) => {
    const fixture = createStandardPersistenceFixture();
    const snapshot = {
      ...fixture,
      elements: fixture.elements.filter(({ kind }) => kind === "stroke"),
    };
    expect(snapshot.elements).toHaveLength(10_000);
    const serialized = serializeInkbookDocument(snapshot);
    if (!serialized.ok) throw new Error(serialized.error.code);
    const current = serialized.value.svg.slice(
      serialized.value.svg.indexOf('<g id="inkbook-background">'),
    );
    const oldPaths = snapshot.elements
      .map((element) =>
        element.kind === "stroke" && element.style.pressureEnabled
          ? serializeLegacyPressurePath(element)
          : serializeElementPaths(element).join(""),
      )
      .join("");
    const old = current.replace(
      /(<g id="inkbook-content">)[\s\S]*(<\/g><\/svg>)$/u,
      `$1${oldPaths}$2`,
    );
    const legacy = old.replaceAll(/(A[\d.]+ [\d.]+ 0 0 )0/gu, "$11");
    expect(legacy).not.toBe(current);

    for (const [name, input] of [
      ["current", current],
      ["old", old],
      ["legacy", legacy],
    ] as const) {
      const durations: number[] = [];
      for (let run = 0; run < 6; run += 1) {
        const measured = measure(() => {
          const matcher = new StreamingStaticIntegrityMatcher(
            snapshot,
            serialized.value.lockedHeight,
          );
          for (let offset = 0; offset < input.length; offset += 16 * 1024) {
            if (!matcher.write(input.slice(offset, offset + 16 * 1024))) return false;
          }
          return matcher.finish() && matcher.requiresCanonicalRewrite === (name !== "current");
        });
        expect(measured.value).toBe(true);
        if (run > 0) durations.push(measured.durationMs);
      }
      expectProfileBudget(durations, 750);
      await annotateDurations(annotate, `${name} pressure-cap integrity`, durations);
    }
  }, 120_000);
});
