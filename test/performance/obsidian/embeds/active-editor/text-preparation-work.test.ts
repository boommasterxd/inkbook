// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangeSet } from "@codemirror/state";
import type { FontResourceV2 } from "../../../../../src/domain/schema/public";
import * as parser from "../../../../../src/domain/text/markdown-parser";
import type { SvgSceneRenderer } from "../../../../../src/rendering/scene/index";
import { ActiveTextPreparation } from "../../../../../src/obsidian/embeds/active-editor/text-preparation";
import { renderTextMathWidget } from "../../../../../src/obsidian/embeds/active-editor/text-session-presentation";
import type { ObsidianTextMathRenderer } from "../../../../../src/obsidian/text/math-renderer";
import type { EditableDocumentModel } from "../../../../../src/obsidian/embeds/document-session/document-model-port";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { textElement } from "../../../../fixtures/rendering/text";
import { TextFontBindings } from "../../../../../src/obsidian/embeds/active-editor/text-session-font-bindings";
import { observeSchemaArray } from "../../../../fixtures/domain/schema-array-work";
import { TextSessionExtent } from "../../../../../src/obsidian/embeds/active-editor/text-session-extent";
import { ActivePageLayout } from "../../../../../src/obsidian/embeds/active-editor/layout/page-layout";
import type { TextEditingSurface } from "../../../../../src/rendering/scene/text-editing-surface";
import { FrameHarness } from "../../../../fixtures/obsidian/navigation";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";
import { snapshot } from "../../../../unit/domain/schema/fixtures";
import { TextFieldEditor } from "../../../../../src/obsidian/text/editor/text-field-editor";
import { parseTextMarkdown } from "../../../../fixtures/domain/text-source";
import {
  loadedEditorFace,
  textEditorAssetsFixture,
} from "../../../../fixtures/rendering/text-editor-assets";

const measure = vi.hoisted(() =>
  vi.fn((text: string) => ({ width: text.length * 8, ascent: 12, descent: 4 })),
);
vi.mock("../../../../../src/rendering/text/canvas-text-measurer", () => ({
  CanvasTextMeasurer: class {
    public prepareLineMetrics(): Promise<void> {
      return Promise.resolve();
    }

    public measure = measure;
    public dispose(): void {
      /* The fixture owns no browser canvas. */
    }
  },
}));
afterEach(() => {
  vi.restoreAllMocks();
  measure.mockClear();
});

it("bounds native editor font loads to the document registry and releases the cached document", async () => {
  const t = textEditorAssetsFixture(
    Array.from({ length: 64 }, (_, index) => loadedEditorFace(index)),
  );
  const assets = t.mount();
  try {
    await assets.ready;
    expect(t.load).toHaveBeenCalledTimes(64);
    expect(t.target.head.querySelectorAll("#inkbook-fonts")).toHaveLength(1);
    for (let index = 0; index < 100; index++) await assets.prepare();
    expect(t.load).toHaveBeenCalledTimes(64);
    t.fonts.add(loadedEditorFace(64));
    await expect(assets.prepare()).rejects.toThrow("document font limit");
    expect(t.load).toHaveBeenCalledTimes(64);
  } finally {
    assets.dispose();
  }
  expect(t.target.head.querySelector("#inkbook-fonts")).toBeNull();
  expect(t.releaseTheme).toHaveBeenCalledOnce();
});

it("stages one native resize index cooperatively, reuses the validated parse and releases cancelled work", async () => {
  const frames = new FrameHarness();
  let pause = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scheduler = {
    ...workSchedulerFromFrames(frames.window),
    checkpoint: () => (pause ? gate : undefined),
  };
  const element = textElement({ source: "word **bold**\n\n".repeat(2000) });
  const prepared = { ...element, width: 400, style: { ...element.style, fontSize: 45 } };
  const cached = parseTextMarkdown(prepared.source, prepared);
  const blocks = observeSchemaArray(cached.blocks);
  const parsed = { ...cached, blocks: blocks.observed };
  const container = document.createElement("div");
  document.body.append(container);
  const input = new TextFieldEditor({
    container,
    element,
    scheduler,
    onChange: vi.fn(),
    onFinish: vi.fn(),
  });
  const parse = vi.spyOn(parser, "parseTextMarkdownSteps");
  try {
    pause = true;
    const abort = new AbortController();
    const pending = input.prepareGeometry(prepared, abort.signal, parsed);
    await vi.waitFor(() => expect(blocks.work.indexedReads).toBe(1));
    expect(container.querySelector(".inkbook-text-run")).toBeNull();
    abort.abort();
    release();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(blocks.work.indexedReads).toBe(1);
    pause = false;
    blocks.work.indexedReads = 0;
    const viewport = input.view.viewport;
    const visibleBlocks = cached.blocks.filter(
      (block) => block.end >= viewport.from && block.start <= viewport.to,
    );
    // The binary lookup reads the separate prefix-ends index. Publication reads each
    // visible block twice (loop boundary and value), then one following stop boundary.
    const stopBoundary = cached.blocks.some((block) => block.start > viewport.to) ? 1 : 0;
    await input.prepareGeometry(prepared, new AbortController().signal, parsed);
    expect(blocks.work.indexedReads).toBeLessThanOrEqual(
      cached.blocks.length * 2 + visibleBlocks.length * 2 + stopBoundary,
    );
    expect(parse).not.toHaveBeenCalled();
    input.updateElement({ ...prepared, x: 40, y: 50 });
    expect(container.querySelector<HTMLElement>(".inkbook-text-run")!.style.fontSize).toBe("45px");
    expect(parse).not.toHaveBeenCalled();
  } finally {
    input.dispose();
    container.remove();
    expect(frames.pending).toBe(0);
  }
});

it("coalesces source extent measurements and releases temporary page growth without changing saved geometry", () => {
  const frames = new FrameHarness();
  const page = snapshot().page;
  const policy = new ActivePageLayout();
  const initial = policy.committed(page, 100)!.height;
  const begin = vi.fn(() => policy.beginSelectionMove());
  const updateBottom = vi.fn((bottom: number) => policy.previewSelectionMove(page, bottom));
  const finish = vi.fn((committed: boolean) => policy.finishSelectionMove(committed, page, 100));
  const setContentHeight = vi.fn((height: number) => ({
    minX: 0,
    minY: 100,
    maxX: 400,
    maxY: 100 + height,
  }));
  const measureContentHeight = vi.fn(() => 1250.375);
  const native = { contentHeight: 5000, view: { scaleY: 0.5 }, measureContentHeight };
  const input = vi.fn(() => native);
  const extent = new TextSessionExtent({
    scheduler: workSchedulerFromFrames(frames.window),
    surface: { setContentHeight } as unknown as TextEditingSurface,
    layout: { begin, updateBottom, finish },
    input,
    canonicalHeight: () => 32,
  });
  for (let index = 0; index < 1000; index += 1) extent.invalidate();
  expect(frames.pending).toBe(1);
  expect(input).not.toHaveBeenCalled();
  expect(measureContentHeight).not.toHaveBeenCalled();
  frames.flushAll();
  expect(input).toHaveBeenCalledOnce();
  expect(measureContentHeight).toHaveBeenCalledOnce();
  expect(setContentHeight).toHaveBeenCalledExactlyOnceWith(1250.375);
  expect(updateBottom).toHaveBeenCalledExactlyOnceWith(1350.375, false, true);
  expect(policy.height).toBeGreaterThan(initial);
  native.contentHeight = 20;
  measureContentHeight.mockReturnValue(40);
  extent.invalidate();
  expect(frames.pending).toBe(1);
  extent.update();
  expect(frames.pending).toBe(0);
  frames.flushAll();
  expect(setContentHeight).toHaveBeenLastCalledWith(40);
  expect(begin).toHaveBeenCalledOnce();
  extent.invalidate();
  extent.dispose();
  extent.dispose();
  expect(frames.pending).toBe(0);
  expect(finish).toHaveBeenCalledExactlyOnceWith(false);
  policy.transitionCompleted();
  policy.transitionCompleted();
  expect(policy.height).toBe(initial);
  extent.invalidate();
  extent.update();
  expect(input).toHaveBeenCalledTimes(2);
  expect(measureContentHeight).toHaveBeenCalledTimes(2);
});

describe("native font binding lookup work", () => {
  it("composes source changes without visiting 10,000 retained runs and visits only queried bindings", () => {
    const spans = observeSchemaArray(
      Array.from({ length: 10_000 }, (_, start) => ({
        start,
        end: start + 1,
        id: "a".repeat(64),
        family: "inter",
        bold: false,
        italic: false,
      })),
    );
    const bindings = new TextFontBindings();
    bindings.adopt("text", spans.observed);
    bindings.map(ChangeSet.of({ from: 0, insert: "prefix" }, 10_000));
    expect(spans.work.indexedReads).toBe(0);
    const lookup = bindings.snapshot();
    expect(lookup.resolve(textElement().style, { start: 9006, end: 9007 })).toBe("a".repeat(64));
    expect(spans.work.indexedReads).toBeLessThanOrEqual(15);
    const before = spans.work.indexedReads;
    expect(lookup.boundaries(9006, 9016)).toHaveLength(9);
    expect(spans.work.indexedReads - before).toBeLessThanOrEqual(26);
  });
});

describe("native text math publication work", () => {
  it("reuses opened math baselines without native font reads or layout visits and cancels their preparation", async () => {
    const abort = new AbortController();
    let cancelAt = Infinity;
    let reads = () => 0;
    const { prepare } = fixture(() => {
      if (reads() >= cancelAt) abort.abort();
      return undefined;
    });
    vi.spyOn(prepare.math, "resolve").mockResolvedValue({
      width: 8,
      height: 16,
      ascent: 12,
      descent: 4,
      paths: [{ d: "M0 0L1 1" }],
    });
    try {
      const element = await prepare.prepare(
        textElement({ source: "$x$\n".repeat(1000), width: 500 }),
        abort.signal,
      );
      const lines = observeSchemaArray(element.layout.lines);
      const math = observeSchemaArray(element.layout.math!);
      const retained = {
        ...element,
        layout: { ...element.layout, lines: lines.observed, math: math.observed },
      };
      reads = () => math.work.indexedReads;
      await prepare.open(retained, abort.signal);
      const current = element.layout.math![0]!;
      const measured = measure.mock.calls.length;
      const visited = { lines: lines.work.indexedReads, math: math.work.indexedReads };
      for (let index = 0; index < 100; index += 1) {
        await renderTextMathWidget({
          document,
          math: prepare.math,
          latex: "x",
          display: false,
          size: element.style.fontSize,
          width: element.width,
          signal: abort.signal,
          scheduler: immediateWorkScheduler(),
          baselineOffset: (result) =>
            prepare.mathBaselines.offset(current, result, retained.layout),
        });
      }
      expect(measure).toHaveBeenCalledTimes(measured);
      expect(lines.work.indexedReads).toBe(visited.lines);
      expect(math.work.indexedReads).toBe(visited.math);
      math.work.indexedReads = 0;
      cancelAt = 40;
      await expect(prepare.open(retained, abort.signal)).rejects.toThrow();
      expect(math.work.indexedReads).toBe(40);
    } finally {
      prepare.dispose();
    }
  });

  it("cancels actual SVG path creation through central admission before mounting a partial widget", async () => {
    const create = vi.spyOn(document, "createElementNS");
    const writes = () => create.mock.calls.filter((call) => call[1] === "path").length;
    const abort = new AbortController();
    const resolve = vi.fn(async () => ({
      width: 100,
      height: 20,
      ascent: 15,
      descent: 5,
      paths: Array.from({ length: 1000 }, () => ({ d: "M0 0L1 0L1 1Z" })),
    }));
    const scheduler = {
      ...immediateWorkScheduler(),
      checkpoint: () => {
        if (writes() >= 50) abort.abort();
        return undefined;
      },
    };
    await expect(
      renderTextMathWidget({
        document,
        math: { resolve } as unknown as ObsidianTextMathRenderer,
        latex: "x",
        display: true,
        size: 24,
        width: 100,
        signal: abort.signal,
        scheduler,
      }),
    ).rejects.toThrow();
    expect(writes()).toBe(50);
    expect(document.querySelector(".inkbook-text-math-widget")).toBeNull();
    expect(resolve).toHaveBeenCalledWith("x", true, 24, abort.signal, 100, { bold: false });
  });
});

function fixture(checkpoint?: () => undefined) {
  const font: FontResourceV2 = {
    family: "inter",
    style: "normal",
    weight: 400,
    id: "a".repeat(64),
    data: "AA==",
    mimeType: "font/woff2",
  };
  const load = vi.fn(async () => []);
  const renderer = {
    textDocument: { fonts: { load } },
    setTextFonts: vi.fn(),
  } as unknown as SvgSceneRenderer;
  let resources = [font];
  const ensure = vi.fn((additional: readonly FontResourceV2[]) => {
    resources = [...resources, ...additional];
  });
  const model = {
    get fontResources() {
      return resources;
    },
    ensureFontResources: ensure,
  } as unknown as EditableDocumentModel;
  const prepare = new ActiveTextPreparation({
    model,
    renderer,
    scheduler: {
      ...immediateWorkScheduler(),
      ...(checkpoint ? { checkpoint } : {}),
    },
  });
  return { prepare, load, renderer, ensure };
}

it("checks retained indentation once per run without reshaping and cancels field-local inspection", async () => {
  let reads = 0;
  let cancelAt = Infinity;
  const abort = new AbortController();
  const { prepare } = fixture(() => {
    if (reads >= cancelAt) abort.abort();
    return undefined;
  });
  const element = await prepare.prepare(
    textElement({
      source: Array.from({ length: 3000 }, () => " word").join("\n"),
      width: 500,
    }),
    abort.signal,
  );
  const retained = {
    ...element,
    layout: {
      ...element.layout,
      lines: element.layout.lines.map((line) => ({
        ...line,
        runs: line.runs.map((run) => ({
          ...run,
          get text() {
            reads += 1;
            return run.text;
          },
        })),
      })),
    },
  };
  try {
    await prepare.open(retained, abort.signal);
    reads = 0;
    const shaped = measure.mock.calls.length;
    expect(await prepare.repairWhitespaceLayout(retained, abort.signal)).toBe(retained);
    expect(reads).toBe(3000);
    expect(measure).toHaveBeenCalledTimes(shaped);
    reads = 0;
    cancelAt = 40;
    await expect(prepare.repairWhitespaceLayout(retained, abort.signal)).rejects.toThrow();
    expect(reads).toBe(40);
    expect(measure).toHaveBeenCalledTimes(shaped);
  } finally {
    prepare.dispose();
  }
});

describe("active text preparation work", () => {
  it("reuses source parsing, font resolution and stylesheet publication across width reflow", async () => {
    const parsed = vi.spyOn(parser, "parseTextMarkdownSteps");
    const { prepare, load, renderer } = fixture();
    const element = textElement({ source: "hello ".repeat(10_000), width: 500 });
    const first = await prepare.prepare(element, new AbortController().signal);
    const second = await prepare.prepare({ ...element, width: 250 }, new AbortController().signal);
    expect(first.layout.lines.length).toBeGreaterThan(900);
    expect(second.layout.lines.length).toBeGreaterThan(first.layout.lines.length);
    expect(parsed).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
    expect(renderer.setTextFonts).toHaveBeenCalledOnce();
    expect(prepare.document(second)?.source).toBe(element.source);
    prepare.dispose();
  });

  it("interrupts actual glyph measurements through the injected scheduler before remaining source work", async () => {
    const abort = new AbortController();
    const { prepare } = fixture(() => {
      if (measure.mock.calls.length >= 200) abort.abort();
      return undefined;
    });
    const element = textElement({ source: "hello ".repeat(10_000), width: 500 });
    await expect(prepare.prepare(element, abort.signal)).rejects.toThrow();
    expect(measure.mock.calls.length).toBe(200);
    prepare.dispose();
  });

  it("embeds multiple newly used font faces with one registry update and stylesheet publication", async () => {
    const { prepare, load, renderer, ensure } = fixture();
    vi.spyOn(prepare.math, "resolve").mockResolvedValue({
      width: 8,
      height: 16,
      ascent: 12,
      descent: 4,
      paths: [{ d: "M0 0L1 1" }],
    });
    await prepare.prepare(
      textElement({ source: "**bold** and $x$" }),
      new AbortController().signal,
    );
    expect(ensure).toHaveBeenCalledOnce();
    expect(ensure.mock.calls[0]![0]).toHaveLength(2);
    expect(ensure.mock.calls[0]![0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ family: "inter", weight: 700 }),
        expect.objectContaining({ family: "jetbrains-mono", weight: 400 }),
      ]),
    );
    expect(renderer.setTextFonts).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledTimes(3);
    prepare.dispose();
  });
});
