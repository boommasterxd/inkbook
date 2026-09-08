import { describe, expect, it } from "vitest";

import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import { StreamingStaticIntegrityMatcher } from "../../../src/persistence/serialization/streaming-static-integrity";
import { createStandardPersistenceFixture } from "./fixtures";
import { annotateDurations, expectProfileBudget, measure } from "./metrics";

describe("pressure-group static integrity performance", () => {
  it("verifies 10,000 pressure groups within the unlock budget", async ({ annotate }) => {
    const fixture = createStandardPersistenceFixture();
    const snapshot = {
      ...fixture,
      elements: fixture.elements
        .filter((element) => element.kind === "stroke")
        .map((element) => ({
          ...element,
          tool: "pen" as const,
          style: { ...element.style, pressureEnabled: true },
        })),
    };
    expect(snapshot.elements).toHaveLength(10_000);
    const serialized = serializeInkbookDocument(snapshot);
    if (!serialized.ok) throw new Error(serialized.error.code);
    const current = serialized.value.svg.slice(
      serialized.value.svg.indexOf('<g id="inkbook-background">'),
    );
    expect(current.match(/<g opacity=/gu)).toHaveLength(10_000);
    const durations: number[] = [];
    for (let run = 0; run < 6; run += 1) {
      const measured = measure(() => {
        const matcher = new StreamingStaticIntegrityMatcher(
          snapshot,
          serialized.value.lockedHeight,
        );
        for (let offset = 0; offset < current.length; offset += 16 * 1024) {
          if (!matcher.write(current.slice(offset, offset + 16 * 1024))) return false;
        }
        return matcher.finish();
      });
      expect(measured.value).toBe(true);
      if (run > 0) durations.push(measured.durationMs);
    }
    expectProfileBudget(durations, 750);
    await annotateDurations(annotate, "canonical pressure-group integrity", durations);
  }, 120_000);
});
