import type { TextElementV2 } from "../../../src/domain/schema/types";

export function textElement(overrides: Partial<TextElementV2> = {}): TextElementV2 {
  return {
    kind: "text",
    id: "00000000-0000-4000-8000-000000000001",
    createdAt: 0,
    rotation: 0,
    pivot: { x: 110, y: 70 },
    x: 10,
    y: 20,
    width: 200,
    height: 100,
    source: "Hello & <world>",
    style: {
      fontFamily: "inter",
      fontSize: 24,
      color: { type: "theme-text" },
      opacity: 0.75,
      bold: false,
      italic: false,
      underline: false,
      strikethrough: false,
    },
    ranges: [],
    paragraphs: [{ start: 0, alignment: "left" }],
    backgroundColor: { type: "rgba", value: "#FFAA22FF" },
    backgroundOpacity: 0.5,
    layout: {
      version: 1,
      lines: [
        {
          x: 2,
          y: 3,
          width: 190,
          height: 30,
          baseline: 23,
          runs: [{ text: "Hello & <world>", start: 0, end: 15, x: 4, width: 160 }],
        },
      ],
    },
    ...overrides,
  };
}

export function singleLineTextElement(source: string): TextElementV2 {
  return textElement({
    source,
    layout: {
      version: 1,
      lines: [
        {
          x: 0,
          y: 0,
          width: 50,
          height: 25,
          baseline: 20,
          runs: [{ text: source, x: 0, width: 50, start: 0, end: source.length }],
        },
      ],
    },
  });
}
