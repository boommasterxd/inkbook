import { describe, expect, it } from "vitest";

import {
  deriveRenderBands,
  isHighlightElement,
  renderBandOf,
  type RenderBandElement,
} from "../../../../src/domain/commands/render-bands";

type TestElement = RenderBandElement & { readonly id: string };

describe("render bands", () => {
  it("classifies both highlighter representations into the highlight band", () => {
    expect(isHighlightElement({ kind: "stroke", tool: "highlighter" })).toBe(true);
    expect(renderBandOf({ kind: "straight-highlighter" })).toBe("highlight");
    expect(renderBandOf({ kind: "stroke", tool: "pen" })).toBe("content");
    expect(renderBandOf({ kind: "rectangle" })).toBe("content");
  });

  it("derives fixed bands while preserving stable order within each band", () => {
    const elements: readonly TestElement[] = [
      { id: "pen-a", kind: "stroke", tool: "pen" },
      { id: "highlight-a", kind: "stroke", tool: "highlighter" },
      { id: "shape", kind: "rectangle" },
      { id: "highlight-b", kind: "straight-highlighter" },
      { id: "pen-b", kind: "stroke", tool: "pen" },
    ];

    const bands = deriveRenderBands(elements);

    expect(bands.highlight.map(({ id }) => id)).toEqual(["highlight-a", "highlight-b"]);
    expect(bands.content.map(({ id }) => id)).toEqual(["pen-a", "shape", "pen-b"]);
  });
});
