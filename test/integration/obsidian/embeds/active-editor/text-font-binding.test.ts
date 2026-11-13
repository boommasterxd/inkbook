import { ChangeSet } from "@codemirror/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FontResourceV2 } from "../../../../../src/domain/schema/public";
import { ElementStore } from "../../../../../src/domain/store/public";
import { fontResourceCssFamily } from "../../../../../src/domain/text/font-family";
import { ActiveTextPreparation } from "../../../../../src/obsidian/embeds/active-editor/text-preparation";
import type { EditableDocumentModel } from "../../../../../src/obsidian/embeds/document-session/document-model-port";
import type { SvgSceneRenderer } from "../../../../../src/rendering/scene/index";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { textElement } from "../../../../fixtures/rendering/text";
import { expandLegacyTextPaddingSteps } from "../../../../../src/domain/geometry/text-padding";
import { scaleElement } from "../../../../../src/editor/selection/transform/transforms";
import { finishGeometrySteps } from "../../../../fixtures/domain/geometry-steps";

const ids = vi.hoisted(() => ({ regular: "a".repeat(64), bold: "b".repeat(64) }));
const primed = vi.hoisted(() => vi.fn());
vi.mock("../../../../../src/rendering/text/canvas-text-measurer", () => ({
  CanvasTextMeasurer: class {
    public prepareLineMetrics(requests: Iterable<unknown>): Promise<void> {
      primed([...requests]);
      return Promise.resolve();
    }

    public measure(text: string, _style: unknown, id?: string) {
      return {
        width: text.length * (id === ids.bold ? 12 : 8),
        ascent: id === ids.bold ? 20 : 12,
        descent: id === ids.bold ? 8 : 4,
      };
    }
    public dispose(): void {
      /* No native canvas belongs to this measured adapter. */
    }
  },
}));
afterEach(() => {
  vi.restoreAllMocks();
  primed.mockClear();
});

function fixture(
  options: {
    readonly resourceFamily?: string;
    readonly unavailableLibrary?: boolean;
    readonly boundBold?: boolean;
    readonly onlyBold?: boolean;
  } = {},
) {
  const family = `custom-${"c".repeat(64)}`;
  const regular: FontResourceV2 = {
    id: ids.regular,
    family: options.resourceFamily ?? family,
    weight: 400,
    style: "normal",
    mimeType: "font/woff2",
    data: "AA==",
  };
  const bold: FontResourceV2 = { ...regular, id: ids.bold, weight: 700 };
  const bound = options.boundBold || options.onlyBold ? bold : regular;
  const element = textElement({
    source: "**old**",
    style: { ...textElement().style, fontFamily: family },
    layout: {
      version: 1,
      baseFontResourceId: bound.id,
      lines: [
        {
          x: 0,
          y: 0,
          width: 24,
          height: 20,
          baseline: 15,
          runs: [
            {
              text: "old",
              start: 2,
              end: 5,
              x: 0,
              width: 24,
              style: { bold: true },
              fontResourceId: bound.id,
            },
          ],
        },
      ],
    },
  });
  let resources = options.onlyBold ? [bold] : options.boundBold ? [regular, bold] : [regular];
  const store = new ElementStore([element]);
  const ensure = vi.fn((added: readonly FontResourceV2[]) => {
    resources = [...resources, ...added];
  });
  const load = vi.fn(async () => []);
  const resolve = vi.fn(async () => bold);
  const preparation = new ActiveTextPreparation({
    model: {
      store,
      get fontResources() {
        return resources;
      },
      ensureFontResources: ensure,
    } as unknown as EditableDocumentModel,
    renderer: {
      textDocument: { fonts: { load } },
      setTextFonts: vi.fn(),
    } as unknown as SvgSceneRenderer,
    scheduler: immediateWorkScheduler(),
    ...(options.unavailableLibrary
      ? {}
      : { library: { match: () => bold, resolve, choices: () => [] } }),
  });
  return { preparation, element, store, resolve, ensure, load, regular, bold };
}

it("retains a uniformly scaled inset when typing, caps narrow reflow and recalculates font-size changes", async () => {
  const { preparation, element, store } = fixture();
  const padded = finishGeometrySteps(expandLegacyTextPaddingSteps(element));
  const scaled = scaleElement(padded, padded.pivot, { x: 2, y: 2 });
  if (scaled.kind !== "text") throw new Error("Expected a scaled text field.");
  store.replace(element.id, scaled);
  const signal = new AbortController().signal;
  try {
    const enlarged = scaleElement(scaled, scaled.pivot, { x: 1.2, y: 1.2 });
    if (enlarged.kind !== "text") throw new Error("Expected a scaled text field.");
    const geometry = await preparation.prepare(enlarged, signal, { preservePadding: true });
    expect(geometry.layout.padding).toBe(67.2);
    expect(geometry.width - geometry.layout.padding! * 2).toBeCloseTo(
      (scaled.width - scaled.layout.padding! * 2) * 1.2,
      3,
    );
    const typed = await preparation.prepare({ ...scaled, source: "**old**!" }, signal);
    expect(typed.layout.padding).toBe(56);
    expect(typed.layout.lines[0]!.x).toBe(56);
    expect(typed.layout.lines[0]!.y).toBe(56);
    const narrow = await preparation.prepare({ ...typed, width: 160 }, signal);
    expect(narrow.layout.padding).toBe(40);
    const smaller = await preparation.prepare(
      { ...typed, style: { ...typed.style, fontSize: 20 } },
      signal,
    );
    expect(smaller.layout.padding).toBe(28);
  } finally {
    preparation.dispose();
  }
});
it("formats a portable regrouped family from its bound embedded file after the local library is removed", async () => {
  const { preparation, element, regular, ensure, resolve } = fixture({
    resourceFamily: `custom-${"d".repeat(64)}`,
    unavailableLibrary: true,
  });
  const signal = new AbortController().signal;
  await preparation.open(element, signal);
  const italic = await preparation.prepare(
    { ...element, ranges: [{ start: 2, end: 5, style: { italic: true } }] },
    signal,
  );
  expect(italic.layout.lines[0]?.runs[0]).toMatchObject({
    fontResourceId: ids.regular,
    style: { italic: true },
  });
  expect(regular.family).not.toBe(element.style.fontFamily);
  expect(ensure).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
  preparation.dispose();
});

describe("stable text font resource bindings", () => {
  it("keeps saved faux-bold runs stable and uses a previously imported real face after a new Bold toggle", async () => {
    const { preparation, element, resolve, load } = fixture();
    const signal = new AbortController().signal;
    await preparation.open(element, signal);
    expect(resolve).not.toHaveBeenCalled();
    const old = await preparation.prepare(element, signal);
    expect(old.layout.lines[0]?.runs[0]?.fontResourceId).toBe(ids.regular);
    expect(primed).toHaveBeenLastCalledWith([
      expect.objectContaining({ fontResourceId: ids.regular }),
    ]);
    expect(resolve).toHaveBeenCalledOnce();
    preparation.adopt(old);
    preparation.mapChanges(
      ChangeSet.of(
        [
          { from: 0, to: 2 },
          { from: 5, to: 7 },
        ],
        7,
      ),
    );
    const plain = await preparation.prepare({ ...old, source: "old" }, signal);
    preparation.adopt(plain);
    preparation.mapChanges(
      ChangeSet.of(
        [
          { from: 0, insert: "**" },
          { from: 3, insert: "**" },
        ],
        3,
      ),
    );
    const real = await preparation.prepare({ ...plain, source: "**old**" }, signal);
    expect(primed).toHaveBeenLastCalledWith([
      expect.objectContaining({ fontResourceId: ids.bold }),
    ]);
    expect(real.layout.lines[0]?.runs[0]?.fontResourceId).toBe(ids.bold);
    expect(real.layout.lines[0]?.runs[0]?.width).toBe(36);
    expect(old.layout.lines[0]?.runs[0]?.fontResourceId).toBe(ids.regular);
    expect(load).toHaveBeenCalledWith(`normal 700 24px "${fontResourceCssFamily(ids.bold)}"`);
    await preparation.open(element, signal);
    expect(
      preparation.resolveFontResourceId({ ...element.style, bold: true }, { start: 2, end: 5 }),
    ).toBe(ids.regular);
    preparation.dispose();
  });

  it("rebases unchanged faux runs through composed native edits while new exact faces become available", async () => {
    const { preparation, element } = fixture();
    const signal = new AbortController().signal;
    await preparation.open(element, signal);
    preparation.mapChanges(ChangeSet.of({ from: 4, insert: "X" }, 7));
    preparation.mapChanges(ChangeSet.of({ from: 0, insert: "P " }, 8));
    const next = await preparation.prepare({ ...element, source: "P **olXd**" }, signal);
    const runs = next.layout.lines.flatMap((line) => line.runs);
    expect(runs.find((run) => run.text === "olXd")).toMatchObject({
      fontResourceId: ids.regular,
      width: 32,
    });
    preparation.dispose();
  });
});

describe("portable text strut font bindings", () => {
  it("keeps differing actual face metrics unchanged when an unused regular file is absent after reload", async () => {
    const warm = fixture({ boundBold: true, unavailableLibrary: true });
    const signal = new AbortController().signal;
    await warm.preparation.open(warm.element, signal);
    const original = await warm.preparation.prepare(warm.element, signal);
    const cold = fixture({ onlyBold: true, unavailableLibrary: true });
    await cold.preparation.open({ ...original }, signal);
    const reopened = await cold.preparation.prepare({ ...original }, signal);
    expect(reopened.layout.baseFontResourceId).toBe(ids.bold);
    expect(reopened.layout.lines).toEqual(original.layout.lines);
    expect(reopened.height).toBe(original.height);
    expect(warm.load).not.toHaveBeenCalledWith(
      expect.stringContaining(fontResourceCssFamily(ids.regular)),
    );
    expect(cold.ensure).not.toHaveBeenCalled();
    warm.preparation.dispose();
    cold.preparation.dispose();
  });

  it("reflows a math-only regrouped family using its bound base file after library removal", async () => {
    const { preparation, element } = fixture({
      resourceFamily: `custom-${"d".repeat(64)}`,
      unavailableLibrary: true,
    });
    const signal = new AbortController().signal;
    const math = {
      ...element,
      source: "$x$",
      layout: { version: 1 as const, baseFontResourceId: ids.regular, lines: [] },
    };
    vi.spyOn(preparation.math, "resolve").mockResolvedValue({
      width: 12,
      height: 16,
      ascent: 12,
      descent: 4,
      paths: [{ d: "M0 0L1 1" }],
    });
    await preparation.open(math, signal);
    const next = await preparation.prepare(math, signal);
    expect(next.layout.baseFontResourceId).toBe(ids.regular);
    expect(next.layout.math).toHaveLength(1);
    preparation.dispose();
  });
});
