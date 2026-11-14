import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { parseTextMarkdown } from "../../../../fixtures/domain/text-source";
import { buildTextDecorations } from "../../../../../src/obsidian/text/editor/text-preview-decorations";
import {
  indexTextPreviewSteps,
  type IndexedTextPreview,
} from "../../../../../src/obsidian/text/editor/text-preview-index";
import type { TextMathWidgetPorts } from "../../../../../src/obsidian/text/editor/text-field-editor-types";
import { textElement } from "../../../domain/schema/fixtures";
import { TextFontBindingLookup } from "../../../../../src/obsidian/embeds/active-editor/text-session-font-bindings";

function complete<Value>(steps: Generator<void, Value>): Value {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

function tailDecorations(
  source: string,
  indexed: IndexedTextPreview,
  ports: Partial<TextMathWidgetPorts> = {},
) {
  const state = EditorState.create({ doc: source, selection: { anchor: source.length - 4 } });
  return buildTextDecorations(state, indexed, [{ start: source.length - 24, end: source.length }], {
    render: undefined,
    onError: undefined,
    activate: vi.fn(),
    width: () => 100,
    style: () => textElement().style,
    ...ports,
  });
}

describe("native table viewport work", () => {
  it("constructs only the visible table preview without visiting its cell runs on caret changes", () => {
    const table = "| A | B |\n| --- | --- |\n| first | second |\n\n";
    const source = `${table.repeat(1_000)}after`;
    const parsed = parseTextMarkdown(source, { style: textElement().style });
    const indexed = complete(indexTextPreviewSteps(parsed));
    let tableReads = 0;
    let runReads = 0;
    for (const block of parsed.blocks) {
      const value = block.table;
      Object.defineProperty(block, "table", {
        get: () => {
          tableReads += 1;
          return value;
        },
      });
      for (const run of block.runs) {
        const start = run.start;
        Object.defineProperty(run, "start", {
          get: () => {
            runReads += 1;
            return start;
          },
        });
      }
    }
    const state = EditorState.create({ doc: source, selection: { anchor: source.length } });
    const decorations = buildTextDecorations(
      state,
      indexed,
      [{ start: source.length - table.length, end: source.length - 7 }],
      {
        render: undefined,
        renderTable: vi.fn(),
        onError: undefined,
        activate: vi.fn(),
        width: () => 100,
        style: () => textElement().style,
      },
    );
    expect(decorations.size).toBe(1);
    expect(tableReads).toBe(1);
    expect(runReads).toBe(0);
  });
});

describe("native preview viewport work", () => {
  it("visits visible source ranges without rescanning a long paragraph on cursor changes", () => {
    const source = "**word**\n".repeat(10_000);
    const parsed = parseTextMarkdown(source, { style: textElement().style });
    const indexed = complete(indexTextPreviewSteps(parsed));
    const counts = { runs: 0, spans: 0 };
    for (const block of parsed.blocks) {
      for (const run of block.runs) {
        const start = run.start;
        Object.defineProperty(run, "start", {
          get: () => {
            counts.runs += 1;
            return start;
          },
        });
      }
      for (const span of block.spans) {
        const start = span.start;
        Object.defineProperty(span, "start", {
          get: () => {
            counts.spans += 1;
            return start;
          },
        });
      }
    }
    const state = EditorState.create({ doc: source, selection: { anchor: source.length - 4 } });
    const lines = vi.spyOn(state.doc, "line");
    const decorations = buildTextDecorations(
      state,
      indexed,
      [{ start: source.length - 18, end: source.length }],
      {
        render: undefined,
        onError: undefined,
        activate: vi.fn(),
        width: () => 100,
        style: () => textElement().style,
      },
    );
    expect(decorations.size).toBeGreaterThan(0);
    expect(counts.runs).toBeLessThan(30);
    expect(counts.spans).toBeLessThan(30);
    expect(lines.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("retains the enclosing inline construct when the viewport starts inside nested formatting", () => {
    const source = "**strong *nested* content** end";
    const parsed = parseTextMarkdown(source, { style: textElement().style });
    const indexed = complete(indexTextPreviewSteps(parsed));
    const state = EditorState.create({ doc: source, selection: { anchor: source.length } });
    const decorations = buildTextDecorations(state, indexed, [{ start: 19, end: 22 }], {
      render: undefined,
      onError: undefined,
      activate: vi.fn(),
      width: () => 100,
      style: () => textElement().style,
    });
    const replacements: [number, number][] = [];
    decorations.between(0, source.length, (start, end, decoration) => {
      const spec = decoration.spec as { widget?: unknown; class?: unknown };
      if (spec.widget === undefined && spec.class === undefined && start < end)
        replacements.push([start, end]);
    });
    expect(replacements).toContainEqual([0, 2]);
    expect(replacements).toContainEqual([25, 27]);
  });
});

describe("native preview font binding work", () => {
  it("queries only visible font fragments inside one long semantic run on caret updates", () => {
    const source = "wordword".repeat(10_000);
    const style = textElement().style;
    const parsed = parseTextMarkdown(source, { style });
    const indexed = complete(indexTextPreviewSteps(parsed));
    let reads = 0;
    const hints = Array.from({ length: 10_000 }, (_, index) => ({
      get start() {
        reads += 1;
        return index * 8;
      },
      get end() {
        reads += 1;
        return index * 8 + 8;
      },
      id: (index % 2 ? "a" : "b").repeat(64),
      family: style.fontFamily,
      bold: false,
      italic: false,
    }));
    const lookup = new TextFontBindingLookup(hints);
    const boundaries = vi.fn((start: number, end: number) => lookup.boundaries(start, end));
    const decorations = tailDecorations(source, indexed, {
      resolveFontResourceId: (effective, range) => lookup.resolve(effective, range),
      fontResourceBoundaries: boundaries,
    });
    expect(decorations.size).toBeGreaterThan(0);
    expect(boundaries).toHaveBeenCalledExactlyOnceWith(source.length - 24, source.length);
    expect(reads).toBeLessThan(200);
  });
});

describe("native TeX viewport work", () => {
  it("reuses cached syntax and visits only the visible token ranges on caret updates", () => {
    const source = `$${"x+".repeat(25_000)}$`;
    const style = textElement().style;
    const indexed = complete(indexTextPreviewSteps(parseTextMarkdown(source, { style })));
    let reads = 0;
    for (const index of indexed.mathSyntax.values()) {
      for (const token of index.values) {
        const start = token.start;
        Object.defineProperty(token, "start", {
          get: () => {
            reads += 1;
            return start;
          },
        });
      }
    }
    const decorations = tailDecorations(source, indexed);
    expect(decorations.size).toBeGreaterThan(4);
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThan(40);
  });
});
