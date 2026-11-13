// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveTextPreparation } from "../../../../../src/obsidian/embeds/active-editor/text-preparation";
import { commitTextReplacement } from "../../../../../src/obsidian/embeds/active-editor/text-session-history";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import type { EditableDocumentModel } from "../../../../../src/obsidian/embeds/document-session/document-model-port";
import type { SvgSceneRenderer } from "../../../../../src/rendering/scene";
import { ElementStore } from "../../../../../src/domain/store/public";
import type { FontResourceV2, TextElementV2 } from "../../../../../src/domain/schema/public";
import { resolveShapeAnchor } from "../../../../../src/domain/geometry/anchors";
import { pointDistance, rotatePointClockwise } from "../../../../../src/domain/geometry/primitives";
import { textElement } from "../../../../fixtures/rendering/text";
import { line } from "../../../../unit/domain/schema/fixtures";
import { elementReplacementPorts } from "../../../../fixtures/obsidian/element-mutation-ports";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";

vi.mock("../../../../../src/rendering/text/canvas-text-measurer", async () => ({
  CanvasTextMeasurer: (await import("../../../../fixtures/rendering/fixed-text-measurer"))
    .FixedTextMeasurer,
}));

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
});

function createPreparation(rotation: number) {
  const target = textElement({
    rotation,
    source: "Unchanged first line",
    width: 240,
    pivot: { x: 130, y: 70 },
  });
  const store = new ElementStore([target]);
  let revision = 0;
  const resources: FontResourceV2[] = [
    {
      id: "a".repeat(64),
      family: "inter",
      weight: 400,
      style: "normal",
      mimeType: "font/woff2",
      data: "AA==",
    },
  ];
  const model = {
    store,
    get revision() {
      return revision;
    },
    fontResources: resources,
    mutationAvailability: "available",
    ...elementReplacementPorts(store, () => {
      revision += 1;
    }),
  } as unknown as EditableDocumentModel;
  const renderer = {
    textDocument: { fonts: { load: async () => [] } },
    setTextFonts: vi.fn(),
  } as unknown as SvgSceneRenderer;
  const prepare = new ActiveTextPreparation({
    model,
    renderer,
    scheduler: immediateWorkScheduler(),
  });
  const history = new ActiveEditorHistory(model);
  disposers.push(() => {
    prepare.dispose();
    history.dispose();
  });
  return { target, store, model, prepare, history };
}

function firstGlyph(element: TextElementV2) {
  const line = element.layout.lines[0]!;
  const run = line.runs[0]!;
  return rotatePointClockwise(
    { x: element.x + line.x + run.x, y: element.y + line.y + line.baseline },
    element.pivot,
    element.rotation,
  );
}

describe("rotated automatic text height", () => {
  it.each([0, 30, 90])(
    "keeps source reflow stationary and replays connected geometry exactly at %s degrees",
    async (rotation) => {
      const { target, store, model, prepare, history } = createPreparation(rotation);
      const signal = new AbortController().signal;
      const initial = await prepare.prepare(target, signal);
      store.replaceMany([initial]);
      const connection = {
        ...line(),
        start: resolveShapeAnchor(initial, { kind: "box", position: "bottom-right" })!,
        startConnection: {
          targetId: target.id,
          anchor: { kind: "box", position: "bottom-right" } as const,
        },
      };
      store.create(connection);
      const before = [store.get(target.id)!.element, store.get(connection.id)!.element];
      const origin = rotatePointClockwise(initial, initial.pivot, rotation);
      const expanded = await prepare.prepare(
        {
          ...initial,
          source:
            initial.source +
            "\n\nAdded paragraph with enough words to wrap several times.".repeat(5),
        },
        signal,
      );
      expect(expanded.height).toBeGreaterThan(initial.height);
      expect(pointDistance(firstGlyph(expanded), firstGlyph(initial))).toBeLessThanOrEqual(0.003);
      expect(
        pointDistance(rotatePointClockwise(expanded, expanded.pivot, rotation), origin),
      ).toBeLessThanOrEqual(0.003);
      expect(await commitTextReplacement(model, history, expanded, signal)).toBe(true);
      expect(store.get(connection.id)!.element).toMatchObject({
        start: resolveShapeAnchor(expanded, { kind: "box", position: "bottom-right" }),
      });
      expect(store.get(connection.id)!.element).not.toEqual(before[1]);
      expect(await history.undoAsync()).toBe(true);
      expect([store.get(target.id)!.element, store.get(connection.id)!.element]).toEqual(before);
      expect(await history.redoAsync()).toBe(true);
      expect(store.get(target.id)!.element).toEqual(expanded);
    },
  );

  it.each([0, 30, 90])(
    "keeps the field origin fixed when font sizing changes height at %s degrees",
    async (rotation) => {
      const { target, prepare } = createPreparation(rotation);
      const signal = new AbortController().signal;
      const initial = await prepare.prepare(target, signal);
      const styled = await prepare.prepare(
        { ...initial, style: { ...initial.style, fontSize: 48 } },
        signal,
      );
      expect(styled.height).not.toBe(initial.height);
      const origin = rotatePointClockwise(initial, initial.pivot, rotation);
      expect(
        pointDistance(rotatePointClockwise(styled, styled.pivot, rotation), origin),
      ).toBeLessThanOrEqual(0.003);
    },
  );
});
