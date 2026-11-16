import { describe, expect, it, vi } from "vitest";
import {
  measureTextRunInkBounds,
  prepareTextInkBounds,
} from "../../../../src/rendering/text/text-ink-bounds";
import { textElement } from "../../../fixtures/rendering/text";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { layoutTextMarkdown } from "../../../../src/rendering/text/text-layout";
import { parseTextMarkdown } from "../../../fixtures/domain/text-source";
import { scaledTextContent } from "../../../../src/domain/geometry/text-scale";

function measurement() {
  return {
    measure: vi.fn((_text: string) => ({
      width: 8,
      ascent: 18,
      descent: 6,
      inkBounds: { minX: -2.1234, minY: -25.1234, maxX: 15.816, maxY: 3.0001 },
    })),
  };
}

describe("measured portable text ink bounds", () => {
  it("preserves italic overhang beyond the advance and scales to the SVG textLength", () => {
    const element = textElement();
    const run = { text: "‾", start: 0, end: 1, x: 0, width: 4, style: { italic: true } };
    const measure = measurement();
    expect(measureTextRunInkBounds(run, element.style, measure)).toEqual({
      minX: -1.062,
      minY: -25.124,
      maxX: 7.908,
      maxY: 3.001,
    });
    expect(measure.measure).toHaveBeenCalledExactlyOnceWith(
      "‾",
      { ...element.style, italic: true },
      undefined,
    );
  });

  it("measures the final merged run as shaped text instead of unioning isolated atom boxes", async () => {
    const element = textElement();
    const measure = measurement();
    const result = await layoutTextMarkdown(
      {
        document: parseTextMarkdown("one two", { style: element.style }),
        width: 200,
        style: element.style,
      },
      { measure, scheduler: createTestWorkScheduler() },
    );
    expect(result.layout.lines[0]!.runs).toHaveLength(1);
    const run = result.layout.lines[0]!.runs[0]!;
    expect(run.text).toBe("one two");
    expect(run.inkBounds).toEqual({ minX: -6.371, minY: -25.124, maxX: 47.448, maxY: 3.001 });
    expect(measure.measure.mock.calls.filter(([text]) => text === "one two")).toHaveLength(1);
  });

  it("enriches legacy layout once without reflow and reuses existing measurements", async () => {
    const element = textElement();
    const measure = measurement();
    const ports = { measure, scheduler: createTestWorkScheduler() };
    const prepared = await prepareTextInkBounds(element, ports);
    expect(element.layout.lines[0]!.runs[0]!.inkBounds).toBeUndefined();
    expect(prepared).toEqual({
      ...element,
      layout: {
        ...element.layout,
        lines: [
          {
            ...element.layout.lines[0]!,
            runs: [
              {
                ...element.layout.lines[0]!.runs[0]!,
                inkBounds: {
                  minX: -42.468,
                  minY: -25.124,
                  maxX: 316.32,
                  maxY: 3.001,
                },
              },
            ],
          },
        ],
      },
    });
    expect(await prepareTextInkBounds(prepared, ports)).toBe(prepared);
    expect(measure.measure).toHaveBeenCalledTimes(1);
  });

  it("rejects cancellation before native measurements", async () => {
    const abort = new AbortController();
    abort.abort(new Error("Obsolete layout"));
    const measure = measurement();
    await expect(
      prepareTextInkBounds(textElement(), {
        measure,
        scheduler: createTestWorkScheduler(),
        signal: abort.signal,
      }),
    ).rejects.toThrow("Obsolete layout");
    expect(measure.measure).not.toHaveBeenCalled();
  });

  it("keeps measured glyph extents attached when existing text is proportionally resized", async () => {
    const element = await prepareTextInkBounds(textElement(), {
      measure: measurement(),
      scheduler: createTestWorkScheduler(),
    });
    const scaled = scaledTextContent(element, 0.5);
    expect(scaled.layout.lines[0]!.runs[0]!.inkBounds).toEqual({
      minX: -21.234,
      minY: -12.562,
      maxX: 158.16,
      maxY: 1.501,
    });
    expect(element.layout.lines[0]!.runs[0]!.inkBounds?.maxY).toBe(3.001);
  });
});
