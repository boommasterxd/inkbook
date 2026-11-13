// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import { tableCellAtPosition } from "../../../../../src/obsidian/text/editor/text-table-editing-position";
import { parseTextMarkdown } from "../../../../fixtures/domain/text-source";
import { textElement } from "../../../domain/schema/fixtures";

function mountedTable() {
  const source = "before\n\n| A | B |\n| --- | --- |\n| left | right |\n\nafter";
  const block = parseTextMarkdown(source, { style: textElement().style }).blocks.find(
    (candidate) => candidate.table,
  )!;
  const node = document.createElement("div");
  document.body.append(node);
  // Position resolution reads only the authoritative source descriptor and owned widget DOM.
  const mount = { block, node };
  return { source, mount };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("resolves source positions at headers and final cells while rejecting surrounding prose", () => {
  const { source, mount } = mountedTable();
  expect(tableCellAtPosition(mount, 0)).toBeUndefined();
  expect(tableCellAtPosition(mount, source.length)).toBeUndefined();
  expect(tableCellAtPosition(mount, source.indexOf("A"))).toEqual({ row: 0, column: 0 });
  expect(tableCellAtPosition(mount, source.indexOf("right") + 5)).toEqual({ row: 1, column: 1 });
});

it("resolves nested pointer targets only inside the owned table widget", () => {
  const { mount } = mountedTable();
  const button = document.createElement("button");
  button.dataset.inkbookTableRow = "1";
  button.dataset.inkbookTableColumn = "1";
  const icon = document.createElement("span");
  button.append(icon);
  mount.node.append(button);
  const target = vi.spyOn(document, "elementFromPoint").mockReturnValue(icon);
  expect(tableCellAtPosition(mount, { x: 20, y: 30 })).toEqual({ row: 1, column: 1 });
  document.body.append(button);
  expect(tableCellAtPosition(mount, { x: 20, y: 30 })).toBeUndefined();
  target.mockReturnValue(mount.node);
  expect(tableCellAtPosition(mount, { x: 20, y: 30 })).toBeUndefined();
  target.mockReturnValue(null);
  expect(tableCellAtPosition(mount, { x: -1, y: -1 })).toBeUndefined();
});
