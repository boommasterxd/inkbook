import { describe, expect, it } from "vitest";

import { arrangeRenderBand, type ArrangeAction } from "../../../../src/domain/commands/arrange";
import type { RenderBandElement } from "../../../../src/domain/commands/render-bands";

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
