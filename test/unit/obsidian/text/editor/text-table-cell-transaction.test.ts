import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import { applyTextEditsSteps } from "../../../../../src/domain/text/text-source-edits";
import type { TextSourceChange } from "../../../../../src/domain/text/text-types";
import { textTableCellTransaction } from "../../../../../src/obsidian/text/editor/text-table-cell-transaction";
import { finishGeometrySteps } from "../../../../fixtures/domain/geometry-steps";
import { parseTextMarkdown } from "../../../../fixtures/domain/text-source";
import { textElement } from "../../../domain/schema/fixtures";

const prefix = "| First | Second |\n| --- | --- |\n| ";
const suffix = " | untouched |\n\nafter";
const style = textElement().style;

function forward(source: string, edit: TransactionSpec, parsedSource = source) {
  const block = parseTextMarkdown(prefix + parsedSource + suffix, { style }).blocks[0]!;
  const child = EditorState.create({ doc: source }).update(edit);
  const state = EditorState.create({ doc: prefix + source + suffix });
  const spec = textTableCellTransaction(child, {
    view: { state } as EditorView,
    block,
    start: prefix.length,
  });
  const parent = state.update(spec);
  const updated = parent.newDoc.toString();
  const parsed = parseTextMarkdown(updated, { style }).blocks[0]!.table!;
  expect(parsed.rows).toHaveLength(2);
  expect(parsed.rows[1]!.cells).toHaveLength(2);
  const right = parsed.rows[1]!.cells[1]!;
  expect(updated.slice(right.contentStart, right.contentEnd)).toBe("untouched");
  const cell = updated.slice(prefix.length, updated.length - suffix.length);
  return { parent, child, cell, updated };
}

describe("canonical current-cell transaction normalization", () => {
  it("uses current code spans while the parent parsed block still has earlier offsets", () => {
    const stale = "xx `a` zz";
    const current = "1234" + stale;
    expect(forward(current, { changes: { from: 4, insert: "|" } }, stale).cell).toBe(
      "1234\\|xx `a` zz",
    );
    const codeEnd = current.indexOf("a") + 1;
    expect(forward(current, { changes: { from: codeEnd, insert: "|" } }, stale).cell).toBe(
      "1234xx `a|` zz",
    );
  });

  it("repairs escape parity when an existing pipe's adjacent backslash is inserted or deleted", () => {
    const source = "a \\| b";
    expect(forward(source, { changes: { from: 2, insert: "\\" } }).cell).toBe("a \\\\\\| b");
    expect(forward(source, { changes: { from: 2, to: 3 } }).cell).toBe(source);
    expect(forward("`a | b`", { changes: { from: 6, to: 7 } }).cell).toBe("`a \\| b");
  });

  it("maps the caret after inserted escapes and CRLF normalization", () => {
    const result = forward("ab", {
      changes: { from: 1, insert: "|\r\n" },
      selection: { anchor: 3 },
    });
    expect(result.cell).toBe("a\\| b");
    expect(result.parent.state.selection.main.head).toBe(prefix.length + 4);
  });

  it("keeps unchanged middle-cell and suffix style ranges mapped through fine-grained edits", () => {
    const source = "left middle right";
    const result = forward(source, {
      changes: [
        { from: 0, insert: "|" },
        { from: source.length, insert: "\n" },
      ],
    });
    const changes: TextSourceChange[] = [];
    result.parent.changes.iterChanges((from, to, _newFrom, _newTo, insert) => {
      changes.push({ start: from, end: to, insert: insert.toString() });
    });
    expect(changes).toHaveLength(2);
    expect(changes.every((change) => change.start === change.end)).toBe(true);
    const original = prefix + source + suffix;
    const middle = original.indexOf("middle");
    const after = original.indexOf("after");
    const mapped = finishGeometrySteps(
      applyTextEditsSteps(
        {
          source: original,
          ranges: [
            { start: middle, end: middle + 6, style: { underline: true } },
            { start: after, end: after + 5, style: { bold: true } },
          ],
          paragraphs: [],
        },
        changes,
      ),
    );
    expect(mapped.source).toBe(result.updated);
    expect(mapped.ranges.map((range) => mapped.source.slice(range.start, range.end))).toEqual([
      "middle",
      "after",
    ]);
  });

  it("does not flatten or lex the cell document for selection-only updates", () => {
    const state = EditorState.create({ doc: "plain source" });
    const transaction = state.update({ selection: { anchor: 3 } });
    const stringify = vi.spyOn(transaction.newDoc, "toString");
    const block = parseTextMarkdown(prefix + "plain source" + suffix, { style }).blocks[0]!;
    const spec = textTableCellTransaction(transaction, {
      view: { state } as EditorView,
      block,
      start: prefix.length,
    });
    expect(stringify).not.toHaveBeenCalled();
    expect(spec.changes).toEqual([]);
    expect(spec.selection).toEqual({ anchor: prefix.length + 3, head: prefix.length + 3 });
    stringify.mockRestore();
  });
});
