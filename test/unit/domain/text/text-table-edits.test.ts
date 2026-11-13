import { describe, expect, it } from "vitest";

import { MAX_TEXT_SOURCE_LENGTH } from "../../../../src/domain/schema/public";
import { MAX_TEXT_LAYOUT_ITEMS } from "../../../../src/domain/schema/text-validation-primitives";
import { applyTextEditsSteps } from "../../../../src/domain/text/text-source-edits";
import {
  textTableEditSteps,
  type TextTableEdit,
} from "../../../../src/domain/text/text-table-edits";
import type { TextSourceState } from "../../../../src/domain/text/text-types";
import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";
import { parseTextMarkdown } from "../../../fixtures/domain/text-source";
import { textElement } from "../schema/fixtures";

const style = textElement().style;

function tableEdit(source: string, edit: TextTableEdit) {
  const block = parseTextMarkdown(source, { style }).blocks.find((entry) => entry.table)!;
  const changes = finishGeometrySteps(textTableEditSteps(source, block, edit));
  const state = finishGeometrySteps(
    applyTextEditsSteps({ source, ranges: [], paragraphs: [] }, changes),
  );
  const table = parseTextMarkdown(state.source, { style }).blocks.find((entry) => entry.table);
  const cells = table?.table!.rows.map((row) =>
    row.cells.map((cell) => state.source.slice(cell.contentStart, cell.contentEnd)),
  );
  return { ...state, changes, table, cells };
}

describe("Markdown table source edits", () => {
  it("inserts and appends body rows without changing existing source or CRLFs", () => {
    const source = "Before\r\n| A | B |\r\n| :--- | ---: |\r\n| one | two |\r\nAfter";
    const first = tableEdit(source, { kind: "insert-row", row: 0, placement: "before" });
    expect(first.cells).toEqual([
      ["A", "B"],
      ["", ""],
      ["one", "two"],
    ]);
    expect(first.source).toBe(source.replace("| one", "|  |  |\r\n| one"));
    const before = tableEdit(source, { kind: "insert-row", row: 1, placement: "before" });
    expect(before.source).toBe(first.source);
    const after = tableEdit(source, { kind: "insert-row", row: 1, placement: "after" });
    expect(after.cells).toEqual([
      ["A", "B"],
      ["one", "two"],
      ["", ""],
    ]);
    expect(tableEdit(source, { kind: "append-row" }).source).toBe(after.source);
    expect(after.source.endsWith("\r\nAfter")).toBe(true);
  });

  it("adds columns while preserving escaped pipes, code, LaTeX, and ignored extra source", () => {
    const source = "H | I\n--- | ---:\n**a** \\| b | ``x | y`` | ignored\n$\\frac{a}{b}$ | end";
    const before = tableEdit(source, { kind: "insert-column", column: 0 });
    expect(before.cells).toEqual([
      ["", "H", "I"],
      ["", "**a** \\| b", "``x | y``"],
      ["", "$\\frac{a}{b}$", "end"],
    ]);
    const middle = tableEdit(source, { kind: "insert-column", column: 1 });
    expect(middle.cells![1]).toEqual(["**a** \\| b", "", "``x | y``"]);
    const end = tableEdit(source, { kind: "insert-column", column: 2 });
    expect(end.cells![1]).toEqual(["**a** \\| b", "``x | y``", ""]);
    expect(end.source).toContain("| ignored");
    expect(end.table!.table!.alignments).toEqual(["left", "right", "left"]);
  });

  it("keeps implicit missing cells empty when columns are inserted and deleted", () => {
    const source = "| A | B | C |\n| --- | --- | --- |\n| one |\n| a |  | c | ignored |";
    const inserted = tableEdit(source, { kind: "insert-column", column: 2 });
    expect(inserted.cells![1]).toEqual(["one", "", "", ""]);
    expect(inserted.source).toContain("\n| one |\n");
    const deleted = tableEdit(source, { kind: "delete-column", column: 1 });
    expect(deleted.cells).toEqual([
      ["A", "C"],
      ["one", ""],
      ["a", "c"],
    ]);
    expect(deleted.source).toContain("| ignored |");
    const first = tableEdit(source, { kind: "delete-column", column: 0 });
    expect(first.cells![1]).toEqual(["", ""]);
    expect(first.cells![2]).toEqual(["", "c"]);
  });

  it("retains valid one-column syntax when the outer pipes were omitted", () => {
    const source = "A | B\n--- | ---\none | two";
    expect(tableEdit(source, { kind: "delete-column", column: 0 }).cells).toEqual([["B"], ["two"]]);
    const last = tableEdit(source, { kind: "delete-column", column: 1 });
    expect(last.cells).toEqual([["A"], ["one"]]);
    expect(tableEdit(last.source, { kind: "delete-column", column: 0 }).source).toBe("");
  });
});

describe("Markdown table structure and source mapping", () => {
  it("changes only the requested alignment token", () => {
    const source = "| A | B |\n|  ---   | :-----: |\n| x | y |";
    const result = tableEdit(source, { kind: "align-column", column: 0, alignment: "right" });
    expect(result.source).toBe(source.replace("  ---   ", "  ---:   "));
    expect(result.table!.table!.alignments).toEqual(["right", "center"]);
    expect(
      tableEdit(source, { kind: "align-column", column: 1, alignment: "left" }).table!.table!
        .alignments,
    ).toEqual(["left", "left"]);
    expect(
      tableEdit(source, { kind: "align-column", column: 0, alignment: "center" }).table!.table!
        .alignments,
    ).toEqual(["center", "center"]);
  });

  it("deletes body rows and promotes the next body row to a valid header", () => {
    const source = "Before\n| A | B |\n| :--- | ---: |\n| **one** |\n| three | four |\nAfter";
    const deleted = tableEdit(source, { kind: "delete-row", row: 2 });
    expect(deleted.cells).toEqual([
      ["A", "B"],
      ["**one**", ""],
    ]);
    const promoted = tableEdit(source, { kind: "delete-row", row: 0 });
    expect(promoted.cells).toEqual([
      ["**one**", ""],
      ["three", "four"],
    ]);
    expect(promoted.table!.table!.alignments).toEqual(["left", "right"]);
    expect(promoted.source.startsWith("Before\n")).toBe(true);
    expect(promoted.source.endsWith("\nAfter")).toBe(true);
    const extra = tableEdit("A | B\n--- | ---\na | b | ignored", { kind: "delete-row", row: 0 });
    expect(extra.cells).toEqual([["a", "b"]]);
    expect(tableEdit("| A |\n| --- |", { kind: "delete-row", row: 0 }).table).toBeUndefined();
  });

  it("keeps style ranges on untouched cell bytes and following text mapped through the shared pipeline", () => {
    const source = "A | B\n--- | ---\n**one** | two\nAfter";
    const block = parseTextMarkdown(source, { style }).blocks[0]!;
    const changes = finishGeometrySteps(
      textTableEditSteps(source, block, { kind: "insert-column", column: 1 }),
    );
    const state: TextSourceState = {
      source,
      ranges: [
        {
          start: source.indexOf("one"),
          end: source.indexOf("one") + 3,
          style: { underline: true },
        },
        { start: source.indexOf("After"), end: source.length, style: { italic: true } },
      ],
      paragraphs: [],
    };
    const result = finishGeometrySteps(applyTextEditsSteps(state, changes));
    expect(result.ranges.map((range) => result.source.slice(range.start, range.end))).toEqual([
      "one",
      "After",
    ]);
    expect(changes.every((change) => change.start === change.end)).toBe(true);
  });
});

describe("Markdown table edit admission", () => {
  it("rejects invalid indices and source growth beyond the shared capacity", () => {
    const source = "A | B\n--- | ---";
    expect(() => tableEdit(source, { kind: "delete-row", row: 1 })).toThrow(RangeError);
    expect(() => tableEdit(source, { kind: "insert-column", column: -1 })).toThrow(RangeError);
    expect(() => tableEdit(source, { kind: "delete-column", column: 2 })).toThrow(RangeError);
    const full = source + "\n" + "x".repeat(MAX_TEXT_SOURCE_LENGTH - source.length - 1);
    expect(() => tableEdit(full, { kind: "append-row" })).toThrow("Text source capacity exceeded.");
  });

  it("admits large row edits cooperatively and enforces the existing layout item capacity", () => {
    const source = "| A |\n| --- |\n" + "| x |\n".repeat(2000);
    const block = parseTextMarkdown(source, { style }).blocks[0]!;
    const steps = textTableEditSteps(source, block, { kind: "insert-column", column: 1 });
    for (let index = 0; index < 2000; index += 1) expect(steps.next().done).toBe(false);
    const changes = finishGeometrySteps(steps);
    expect(changes).toHaveLength(2002);
    expect(changes.every((change) => change.start === change.end)).toBe(true);
    const full = "| A |\n| --- |\n" + "| |\n".repeat(MAX_TEXT_LAYOUT_ITEMS - 3);
    expect(() => tableEdit(full, { kind: "append-row" })).toThrow(
      "Text table layout capacity exceeded.",
    );
  });
});
