import { describe, expect, it } from "vitest";
import { validateSafeSvg } from "../../../../src/persistence/documents/safe-svg-validator";
import { ChunkedInkbookInputParser } from "../../../../src/persistence/serialization/chunked-input-codec";
import { PREVIOUS_STROKE_SVG } from "../../../fixtures/persistence/previous-stroke-rendering";
import { LEGACY_OUTLINE_SVG } from "../../../fixtures/persistence/legacy-outline-rendering";
import { ROUNDED_OUTLINE_SVG } from "../../../fixtures/persistence/rounded-outline-rendering";

describe("obsolete rendering rejection", () => {
  it.each([1, 37, 16_384])("rejects old geometry across %i-byte slices", async (slice) => {
    for (const source of [PREVIOUS_STROKE_SVG, LEGACY_OUTLINE_SVG, ROUNDED_OUTLINE_SVG]) {
      expect(validateSafeSvg(source)).not.toBeNull();
      const parser = new ChunkedInkbookInputParser({ inputSliceBytes: slice });
      const written = await parser.write(new TextEncoder().encode(source));
      const result = written.ok ? await parser.finish() : written;
      expect(result).toMatchObject({ ok: false, error: { code: "static-path-mismatch" } });
      expect(parser.maximumRetainedStaticInputCharacters).toBeLessThanOrEqual(slice + 16);
    }
  });
});
