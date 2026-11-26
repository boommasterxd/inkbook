import { type TextElementV2 } from "../../../../src/domain/schema/public";

export function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

export function textElement(index = 8): TextElementV2 {
  return {
    kind: "text",
    id: uuid(index),
    createdAt: 0,
    rotation: 0,
    pivot: { x: 150, y: 125 },
    x: 100,
    y: 100,
    width: 100,
    height: 50,
    source: "Hello",
    style: {
      fontFamily: "sans-serif",
      fontSize: 16.5,
      color: { type: "rgba", value: "#000000FF" },
      opacity: 1,
      bold: false,
      italic: false,
      underline: false,
      strikethrough: false,
    },
    ranges: [],
    paragraphs: [],
    backgroundColor: null,
    backgroundOpacity: 0,
    layout: {
      version: 1,
      lines: [
        {
          x: 0,
          y: 0,
          width: 40,
          height: 20,
          baseline: 15,
          runs: [{ text: "Hello", start: 0, end: 5, x: 0, width: 40 }],
        },
      ],
    },
  };
}
