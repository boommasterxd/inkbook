import { expect, it } from "vitest";
import type { TextLayoutV2 } from "../../../../src/domain/schema/public";
import { TEXT_TAB_SIZE } from "../../../../src/domain/text/text-layout-style";
import { layoutTextMarkdown } from "../../../../src/rendering/text/text-layout";
import { missingTextWhitespaceSteps } from "../../../../src/rendering/text/text-layout-whitespace";
import { parseTextMarkdown } from "../../../fixtures/domain/text-source";
import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { FixedTextMeasurer } from "../../../fixtures/rendering/fixed-text-measurer";
import { textElement } from "../../../fixtures/rendering/text";

async function layout(source: string, width = 200) {
  const style = textElement().style;
  const document = parseTextMarkdown(source, { style });
  const result = await layoutTextMarkdown(
    { document, style, width },
    { measure: new FixedTextMeasurer(), scheduler: createTestWorkScheduler() },
  );
  return { ...result, document };
}

it("preserves indentation, trailing spaces and source ranges around styled explicit lines", async () => {
  const source = " A \n  **B**\n C";
  const result = await layout(source);
  expect(result.layout.lines.map((line) => line.runs.map((run) => run.text).join(""))).toEqual([
    " A ",
    "  B",
    " C",
  ]);
  const bold = result.layout.lines[1]!.runs[1]!;
  expect(bold).toMatchObject({ text: "B", start: 8, end: 9, x: 16, style: { bold: true } });
  expect(finishGeometrySteps(missingTextWhitespaceSteps(result.document, result.layout))).toBe(
    false,
  );
  const old: TextLayoutV2 = {
    ...result.layout,
    lines: result.layout.lines.map((line) => ({
      ...line,
      runs: line.runs
        .filter((run) => run.text.trim())
        .map((run) => ({ ...run, text: run.text.trim(), start: run.start + 1 })),
    })),
  };
  expect(finishGeometrySteps(missingTextWhitespaceSteps(result.document, old))).toBe(true);
});

it("repairs a retained table without its following rail gap and reuses the current spacing", async () => {
  const current = await layout("| H |\n| --- |\n| body |\nafter");
  expect(
    finishGeometrySteps(missingTextWhitespaceSteps(current.document, current.layout, 28)),
  ).toBe(false);
  const table = current.layout.tables![0]!;
  const old: TextLayoutV2 = {
    ...current.layout,
    lines: current.layout.lines.map((line) =>
      line.y >= table.y + table.height ? { ...line, y: line.y - 28 } : line,
    ),
  };
  expect(finishGeometrySteps(missingTextWhitespaceSteps(current.document, old, 28))).toBe(true);
});

it("wraps preserved spaces into their own rows with the editor's break-spaces semantics", async () => {
  const result = await layout("a     b", 28);
  expect(result.layout.lines.map((line) => line.runs.map((run) => run.text).join(""))).toEqual([
    "a  ",
    "   ",
    "b",
  ]);
  expect(result.layout.lines.map((line) => line.width)).toEqual([24, 24, 8]);
});

it("advances tabs to shared four-space stops without stretching neighboring glyphs", async () => {
  const result = await layout(" \tX\nX\tX");
  expect(TEXT_TAB_SIZE).toBe(4);
  for (const line of result.layout.lines) {
    expect(line.runs[line.runs.length - 1]).toMatchObject({ text: "X", x: 32, width: 8 });
    expect(line.runs[1]).toMatchObject({ text: " ", width: 24, end: line.runs[1]!.start + 1 });
  }
  expect(result.document.source).toBe(" \tX\nX\tX");
});

it("ignores Markdown heading and list prefixes when inspecting retained indentation", async () => {
  const result = await layout(" # Heading\n  - item");
  expect(finishGeometrySteps(missingTextWhitespaceSteps(result.document, result.layout))).toBe(
    false,
  );
});
