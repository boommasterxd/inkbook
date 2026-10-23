import { describe, expect, it } from "vitest";
import { validateSafeSvg } from "../../../../src/persistence/documents/safe-svg-validator";
import { ChunkedInkbookInputParser } from "../../../../src/persistence/serialization/input/chunked-input-codec";
import { PREVIOUS_STROKE_SVG } from "../../../fixtures/persistence/previous-stroke-rendering";
import { LEGACY_OUTLINE_SVG } from "../../../fixtures/persistence/legacy-outline-rendering";
import { ROUNDED_OUTLINE_SVG } from "../../../fixtures/persistence/rounded-outline-rendering";

describe("obsolete rendering rejection", () => {
  it.each([
    ["previous stroke", PREVIOUS_STROKE_SVG],
    ["legacy outline", LEGACY_OUTLINE_SVG],
    ["rounded outline", ROUNDED_OUTLINE_SVG],
  ])("rejects %s geometry across byte-slice boundaries", async (_name, source) => {
    expect(validateSafeSvg(source)).not.toBeNull();
    const input = new TextEncoder().encode(source);
    for (const slice of [1, 37, 16_384]) {
      const parser = new ChunkedInkbookInputParser({ inputSliceBytes: slice });
      const written = await parser.write(input);
      const result = written.ok ? await parser.finish() : written;
      expect(result).toMatchObject({ ok: false, error: { code: "static-path-mismatch" } });
      expect(parser.maximumRetainedStaticInputCharacters).toBeLessThanOrEqual(slice + 16);
    }
  });
});
