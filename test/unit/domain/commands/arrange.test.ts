import { describe, expect, it } from "vitest";

import {
  arrangeRenderBandSteps,
  type ArrangeAction,
} from "../../../../src/domain/commands/arrange";
import type { RenderBandElement } from "../../../../src/domain/commands/render-bands";
import { finishGeometrySteps as drain } from "../../../fixtures/domain/geometry-steps";

type TestElement = RenderBandElement & { readonly id: string };

function ids(elements: readonly TestElement[]): string[] {
  return elements.map(({ id }) => id);
}

function content(id: string): TestElement {
  return { id, kind: "rectangle" };
}

describe("arrangeRenderBand", () => {
  const band = ["A", "B", "C", "D", "E"].map(content);

  it.each<{ action: ArrangeAction; expected: string[] }>([
    { action: "bring-forward", expected: ["B", "A", "D", "C", "E"] },
    { action: "send-backward", expected: ["A", "C", "B", "D", "E"] },
    { action: "bring-to-front", expected: ["B", "D", "E", "A", "C"] },
    { action: "send-to-back", expected: ["A", "C", "B", "D", "E"] },
  ])("applies $action stably to multiple original runs", ({ action, expected }) => {
    const result = drain(
      arrangeRenderBandSteps(band, ({ id }) => id === "A" || id === "C", action),
    );

    expect(ids(result.elements)).toEqual(expected);
    expect(result.changed).toBe(true);
  });

  it("moves each multi-element selected run by one adjacent rank", () => {
    const selected = new Set(["B", "C", "E"]);

    const backward = drain(
      arrangeRenderBandSteps(band, ({ id }) => selected.has(id), "send-backward"),
    );
    const forward = drain(
      arrangeRenderBandSteps(band, ({ id }) => selected.has(id), "bring-forward"),
    );

    expect(ids(backward.elements)).toEqual(["B", "C", "A", "E", "D"]);
    expect(ids(forward.elements)).toEqual(["A", "D", "B", "C", "E"]);
  });

  it("determines selection once from the original band", () => {
    let calls = 0;

    drain(
      arrangeRenderBandSteps(
        band,
        ({ id }) => {
          calls += 1;
          return id === "B" || id === "C";
        },
        "bring-forward",
      ),
    );

    expect(calls).toBe(band.length);
  });

  it("preserves the input reference for boundary and empty-selection no-ops", () => {
    const front = drain(arrangeRenderBandSteps(band, ({ id }) => id === "E", "bring-forward"));
    const back = drain(arrangeRenderBandSteps(band, ({ id }) => id === "A", "send-backward"));
    const empty = drain(arrangeRenderBandSteps(band, () => false, "bring-to-front"));

    expect(front).toEqual({ elements: band, changed: false });
    expect(front.elements).toBe(band);
    expect(back.elements).toBe(band);
    expect(empty.elements).toBe(band);
  });

  it.each<ArrangeAction>(["bring-forward", "send-backward", "bring-to-front", "send-to-back"])(
    "preserves source identity for every $0 no-op",
    (action) => {
      const atFront = action === "bring-forward" || action === "bring-to-front";
      const boundary = atFront ? "E" : "A";
      for (const selected of [() => false, () => true, ({ id }: TestElement) => id === boundary]) {
        const result = drain(arrangeRenderBandSteps(band, selected, action, 2));
        expect(result.changed).toBe(false);
        expect(result.elements).toBe(band);
      }
      const empty: readonly TestElement[] = [];
      expect(drain(arrangeRenderBandSteps(empty, () => true, action)).elements).toBe(empty);
    },
  );

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid chunk size %s",
    (stepsPerChunk) => {
      expect(() =>
        arrangeRenderBandSteps(band, () => true, "bring-forward", stepsPerChunk).next(),
      ).toThrow(RangeError);
    },
  );

  it("leaves the readonly source unchanged when preparation is abandoned", () => {
    const source = Object.freeze([...band]);
    const steps = arrangeRenderBandSteps(source, ({ id }) => id !== "E", "bring-forward", 1);
    for (let index = 0; index < source.length + 2; index += 1) steps.next();
    steps.return({ elements: source, changed: false });
    expect(ids(source)).toEqual(["A", "B", "C", "D", "E"]);
  });
});
