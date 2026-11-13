// @vitest-environment happy-dom

import { ChangeSet } from "@codemirror/state";
import { afterEach, expect, it, vi } from "vitest";
import type { TextElementV2, TextStyleV2 } from "../../../../../src/domain/schema/public";
import { ActiveTextPreparation } from "../../../../../src/obsidian/embeds/active-editor/text-preparation";
import { renderTextMathWidget } from "../../../../../src/obsidian/embeds/active-editor/text-session-presentation";
import { createTextSessionEditor } from "../../../../../src/obsidian/embeds/active-editor/text-session-editor";
import type { TextEditingSurface } from "../../../../../src/rendering/scene/text-editing-surface";
import type { EditableDocumentModel } from "../../../../../src/obsidian/embeds/document-session/document-model-port";
import type { SvgSceneRenderer } from "../../../../../src/rendering/scene/index";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { textElement } from "../../../../fixtures/rendering/text";

const metrics = vi.hoisted(() => vi.fn());
vi.mock("../../../../../src/rendering/text/canvas-text-measurer", () => ({
  CanvasTextMeasurer: class {
    public async prepareLineMetrics(requests: Iterable<unknown>) {
      metrics([...requests]);
    }
    public measure(text: string, style: TextStyleV2) {
      return {
        width: text.length * 8,
        ascent: (style.fontSize * 19) / 24,
        descent: (style.fontSize * 7) / 24,
        lineHeight: (style.fontSize * 26) / 24,
      };
    }
    public dispose() {
      /* The fixture owns no native canvas. */
    }
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  metrics.mockClear();
});

function fixture() {
  const scheduler = immediateWorkScheduler();
  const preparation = new ActiveTextPreparation({
    model: {
      fontResources: [
        {
          family: "inter",
          weight: 400,
          style: "normal",
          mimeType: "font/woff2",
          id: "a".repeat(64),
          data: "AA==",
        },
      ],
      ensureFontResources: vi.fn(),
    } as unknown as EditableDocumentModel,
    renderer: {
      textDocument: { fonts: { load: async () => [] } },
      setTextFonts: vi.fn(),
    } as unknown as SvgSceneRenderer,
    scheduler,
  });
  vi.spyOn(preparation.math, "resolve").mockImplementation(async (_latex, _display, size) => ({
    width: size / 2,
    height: (size * 18) / 24,
    ascent: (size * 14) / 24,
    descent: (size * 4) / 24,
    paths: [{ d: "M0 0L1 1" }],
  }));
  const signal = new AbortController().signal;
  const render = async (element: TextElementV2, index = 0) => {
    const math = element.layout.math![index]!;
    return renderTextMathWidget({
      document,
      math: preparation.math,
      latex: "x",
      display: math.display,
      size: element.style.fontSize,
      width: element.width,
      signal,
      scheduler,
      baselineOffset: (result) => preparation.mathBaselines.offset(math, result),
    });
  };
  return { preparation, signal, render };
}

function savedBaseline(element: TextElementV2, delta: number): TextElementV2 {
  return {
    ...element,
    height: element.height + delta,
    layout: {
      ...element.layout,
      lines: element.layout.lines.map((line) => ({
        ...line,
        baseline: line.baseline + delta,
        height: line.height + delta,
      })),
      math: element.layout.math!.map((math) => ({ ...math, y: math.y + delta })),
    },
  };
}

async function openSavedFormula(t: ReturnType<typeof fixture>): Promise<TextElementV2> {
  const fresh = await t.preparation.prepare(textElement({ source: "$x$" }), t.signal);
  await t.preparation.open(savedBaseline(fresh, 1), t.signal);
  return fresh;
}

async function expectOpenedAlignment(t: ReturnType<typeof fixture>, element: TextElementV2) {
  await t.preparation.open(element, t.signal);
  expect((await t.render(element)).style.verticalAlign).toBe("-4px");
}

it.each(["$x$", "$$x$$"])(
  "retains the stored baseline for %s without reflow or rendering-time metrics",
  async (source) => {
    const t = fixture();
    try {
      const fresh = await t.preparation.prepare(textElement({ source }), t.signal);
      const saved = savedBaseline(fresh, 1);
      const layout = structuredClone(saved.layout);
      await t.preparation.open(saved, t.signal);
      t.preparation.adopt(saved);
      const measured = metrics.mock.calls.length;
      const first = await t.render(saved);
      const second = await t.render(saved);
      expect(first.style.verticalAlign).toBe("-5px");
      expect(second.style.verticalAlign).toBe(first.style.verticalAlign);
      expect(metrics).toHaveBeenCalledTimes(measured);
      expect(saved.layout).toEqual(layout);
      t.preparation.mapChanges(ChangeSet.of({ from: 0, insert: "changed " }, saved.source.length));
      expect((await t.render(saved)).style.verticalAlign).toBe("-4px");
    } finally {
      t.preparation.dispose();
    }
  },
);

it("keeps fresh geometry unchanged and discards old adaptation after adopting a replacement layout", async () => {
  const t = fixture();
  try {
    const fresh = await openSavedFormula(t);
    expect((await t.render(fresh)).style.verticalAlign).toBe("-5px");
    t.preparation.adopt(fresh);
    expect((await t.render(fresh)).style.verticalAlign).toBe("-4px");
    await expectOpenedAlignment(t, fresh);
  } finally {
    t.preparation.dispose();
  }
});

it("uses the actual largest run font instead of the field default in a mixed-size math line", async () => {
  const t = fixture();
  try {
    const fresh = await t.preparation.prepare(
      textElement({ source: "large $x$", ranges: [{ start: 0, end: 5, style: { fontSize: 36 } }] }),
      t.signal,
    );
    await expectOpenedAlignment(t, fresh);
  } finally {
    t.preparation.dispose();
  }
});

it("binds staged native formula previews to their target layout while preserving the saved baseline on return", async () => {
  const t = fixture();
  const container = document.createElement("div");
  document.body.append(container);
  let editor: ReturnType<typeof createTextSessionEditor> | undefined;
  try {
    const fresh = await t.preparation.prepare(textElement({ source: "$x$\nend" }), t.signal);
    const saved = savedBaseline(fresh, 1);
    await t.preparation.open(saved, t.signal);
    t.preparation.adopt(saved);
    editor = createTextSessionEditor({
      element: saved,
      surface: {
        container,
        ownerDocument: document,
        setContentHeight: vi.fn(),
      } as unknown as TextEditingSurface,
      scheduler: immediateWorkScheduler(),
      preparation: t.preparation,
      sourceExtentLayout: undefined,
      currentElement: () => saved,
      draft: () => saved,
      onChange: vi.fn(),
      onStateChanged: vi.fn(),
      onFinish: vi.fn(),
      onUndoRedo: vi.fn(),
      onRevealBounds: undefined,
    });
    const input = editor.input;
    input.view.dispatch({ selection: { anchor: input.view.state.doc.length } });
    await input.ready;
    const alignment = () =>
      container.querySelector<HTMLElement>(".inkbook-text-math-content")?.style.verticalAlign;
    await vi.waitFor(() => expect(alignment()).toBe("-5px"));
    await input.prepareGeometry(fresh, t.signal, t.preparation.document(fresh));
    input.updateElement(fresh);
    await vi.waitFor(() => expect(alignment()).toBe("-4px"));
    await input.prepareGeometry(saved, t.signal, t.preparation.document(saved));
    input.updateElement(saved);
    await vi.waitFor(() => expect(alignment()).toBe("-5px"));
  } finally {
    editor?.input.dispose();
    editor?.extent.dispose();
    container.remove();
    t.preparation.dispose();
  }
});

it("leaves a taller current formula unchanged when its saved metrics no longer match", async () => {
  const t = fixture();
  try {
    const fresh = await openSavedFormula(t);
    vi.spyOn(t.preparation.math, "resolve").mockResolvedValue({
      width: 12,
      height: 44,
      ascent: 40,
      descent: 4,
      paths: [{ d: "M0 0L1 1" }],
    });
    expect((await t.render(fresh)).style.verticalAlign).toBe("-4px");
  } finally {
    t.preparation.dispose();
  }
});

it("shares the baseline of a taller neighboring formula without shifting the shorter preview", async () => {
  const t = fixture();
  try {
    vi.spyOn(t.preparation.math, "resolve").mockImplementation(async (latex) => ({
      width: 12,
      height: latex === "tall" ? 44 : 18,
      ascent: latex === "tall" ? 40 : 14,
      descent: 4,
      paths: [{ d: "M0 0L1 1" }],
    }));
    const fresh = await t.preparation.prepare(textElement({ source: "$tall$ $x$" }), t.signal);
    await t.preparation.open(fresh, t.signal);
    expect((await t.render(fresh, 1)).style.verticalAlign).toBe("-4px");
  } finally {
    t.preparation.dispose();
  }
});
