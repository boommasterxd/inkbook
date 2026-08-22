import { describe, expect, it } from "vitest";

import {
  arrangeElements,
  arrangeRenderBand,
  type ArrangeAction,
  type IdentifiedRenderBandElement,
} from "../../../../src/domain/commands/arrange";

type TestElement = IdentifiedRenderBandElement;

function ids(elements: readonly TestElement[]): string[] {
  return elements.map(({ id }) => id);
}

function content(id: string): TestElement {
  return { id, kind: "rectangle" };
}

function highlight(id: string): TestElement {
  return { id, kind: "stroke", tool: "highlighter" };
}

describe("arrangeRenderBand", () => {
  const band = ["A", "B", "C", "D", "E"].map(content);

  it.each<{ action: ArrangeAction; expected: string[] }>([
    { action: "bring-forward", expected: ["B", "A", "D", "C", "E"] },
    { action: "send-backward", expected: ["A", "C", "B", "D", "E"] },
    { action: "bring-to-front", expected: ["B", "D", "E", "A", "C"] },
    { action: "send-to-back", expected: ["A", "C", "B", "D", "E"] },
  ])("applies $action stably to multiple original runs", ({ action, expected }) => {
    const result = arrangeRenderBand(band, ({ id }) => id === "A" || id === "C", action);

    expect(ids(result.elements)).toEqual(expected);
    expect(result.changed).toBe(true);
  });

  it("moves each multi-element selected run by one adjacent rank", () => {
    const selected = new Set(["B", "C", "E"]);

    const backward = arrangeRenderBand(band, ({ id }) => selected.has(id), "send-backward");
    const forward = arrangeRenderBand(band, ({ id }) => selected.has(id), "bring-forward");

    expect(ids(backward.elements)).toEqual(["B", "C", "A", "E", "D"]);
    expect(ids(forward.elements)).toEqual(["A", "D", "B", "C", "E"]);
  });

  it("determines selection once from the original band", () => {
    let calls = 0;

    arrangeRenderBand(
      band,
      ({ id }) => {
        calls += 1;
        return id === "B" || id === "C";
      },
      "bring-forward",
    );

    expect(calls).toBe(band.length);
  });

  it("preserves the input reference for boundary and empty-selection no-ops", () => {
    const front = arrangeRenderBand(band, ({ id }) => id === "E", "bring-forward");
    const back = arrangeRenderBand(band, ({ id }) => id === "A", "send-backward");
    const empty = arrangeRenderBand(band, () => false, "bring-to-front");

    expect(front).toEqual({ elements: band, changed: false });
    expect(front.elements).toBe(band);
    expect(back.elements).toBe(band);
    expect(empty.elements).toBe(band);
  });
});

describe("arrangeElements", () => {
  it("arranges a mixed selection independently inside both fixed bands", () => {
    const elements = [
      highlight("H1"),
      highlight("H2"),
      highlight("H3"),
      content("C1"),
      content("C2"),
      content("C3"),
    ];

    const result = arrangeElements(elements, new Set(["H1", "C2"]), "bring-forward");

    expect(ids(result.elements)).toEqual(["H2", "H1", "H3", "C1", "C3", "C2"]);
    expect(result.changed).toBe(true);
  });

  it("does not allow either band to cross the fixed render boundary", () => {
    const elements = [highlight("H1"), content("C1")];

    const result = arrangeElements(elements, new Set(["H1", "C1"]), "bring-to-front");

    expect(result.changed).toBe(false);
    expect(result.elements).toBe(elements);
  });
});
