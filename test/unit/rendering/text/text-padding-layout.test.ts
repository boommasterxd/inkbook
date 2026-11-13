import { describe, expect, it, vi } from "vitest";
import { canonicalizeGeometryNumber as canonical } from "../../../../src/domain/schema/canonical";
import { layoutTextMarkdown } from "../../../../src/rendering/text/text-layout";
import { parseTextMarkdown } from "../../../fixtures/domain/text-source";
import { FixedTextMeasurer } from "../../../fixtures/rendering/fixed-text-measurer";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { textElement } from "../../domain/schema/fixtures";

describe("outer text padding layout", () => {
  it.each(["left", "center", "right", "justify"] as const)(
    "insets %s wrapped content without changing its content-width layout",
    async (alignment) => {
      const style = textElement().style;
      const document = parseTextMarkdown("aa bb cc dd", {
        style,
        paragraphs: [{ start: 0, alignment }],
      });
      const ports = { measure: new FixedTextMeasurer(), scheduler: createTestWorkScheduler() };
      const legacy = await layoutTextMarkdown({ document, width: 80, style }, ports);
      const padded = await layoutTextMarkdown(
        { document, width: 96.5, padding: 8.25, style },
        ports,
      );
      expect(legacy.layout).not.toHaveProperty("padding");
      expect(padded.layout.padding).toBe(8.25);
      expect(padded.height).toBe(canonical(legacy.height + 16.5));
      expect(padded.layout.lines).toEqual(
        legacy.layout.lines.map((line) => ({
          ...line,
          x: canonical(line.x + 8.25),
          y: canonical(line.y + 8.25),
        })),
      );
    },
  );

  it("passes inner widths to inline/list and display math and insets their paths exactly once", async () => {
    const style = textElement().style;
    const document = parseTextMarkdown("- before $x$ after\n\n$$y$$", { style });
    const resolve = vi.fn(async () => ({
      width: 20,
      height: 20,
      ascent: 16,
      descent: 4,
      paths: [{ d: "M0 0L20 20Z" }],
    }));
    const ports = {
      measure: new FixedTextMeasurer(),
      scheduler: createTestWorkScheduler(),
      math: { resolve },
    };
    const legacy = await layoutTextMarkdown({ document, width: 80, style }, ports);
    resolve.mockClear();
    const padded = await layoutTextMarkdown({ document, width: 96.5, padding: 8.25, style }, ports);
    expect(padded.layout.math).toEqual(
      legacy.layout.math!.map((entry) => ({
        ...entry,
        x: canonical(entry.x + 8.25),
        y: canonical(entry.y + 8.25),
      })),
    );
    expect(resolve.mock.calls.map((call: readonly unknown[]) => call[4])).toEqual([55.25, 80]);
    expect(padded.height).toBe(canonical(legacy.height + 16.5));
  });
});
