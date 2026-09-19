import { describe, expect, it, vi } from "vitest";

import * as pathMarkup from "../../../src/persistence/serialization/path-markup";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import { StreamingStaticIntegrityMatcher } from "../../../src/persistence/serialization/streaming-static-integrity";
import { createPressureGroupFixture } from "./fixtures";

describe("pressure-group static integrity performance", () => {
  it("verifies 10,000 pressure groups through bounded input chunks", () => {
    const snapshot = createPressureGroupFixture();
    expect(snapshot.elements).toHaveLength(10_000);
    const serialized = serializeInkbookDocument(snapshot, { hash: () => "fixture-hash" });
    if (!serialized.ok) throw new Error(serialized.error.code);
    const current = serialized.value.svg.slice(
      serialized.value.svg.indexOf('<g id="inkbook-background">'),
    );
    expect(current.match(/<g opacity=/gu)).toHaveLength(10_000);
    const fragments = vi.spyOn(pathMarkup, "serializeElementPaths");
    const matcher = new StreamingStaticIntegrityMatcher(snapshot, serialized.value.lockedHeight);
    expect(fragments).not.toHaveBeenCalled();
    for (let offset = 0; offset < current.length; offset += 16 * 1024) {
      expect(matcher.write(current.slice(offset, offset + 16 * 1024))).toBe(true);
      if (offset === 0) expect(fragments.mock.calls.length).toBeLessThan(10_000);
    }
    expect(matcher.finish()).toBe(true);
    expect(fragments).toHaveBeenCalledTimes(10_000);
    fragments.mockRestore();
  }, 120_000);
});
