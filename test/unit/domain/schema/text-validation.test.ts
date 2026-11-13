import { describe, expect, it } from "vitest";
import { validateInkElementV1, validateInkSnapshotV1 } from "../../../../src/domain/schema/public";
import { snapshot, textElement } from "./fixtures";

it("accepts coherent bounded table frames and rejects invalid row geometry and combined layout overflow", () => {
  const text = textElement();
  const table = {
    start: 0,
    end: 5,
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    columns: 2,
    rowHeights: [20, 20],
    borderWidth: 1,
  };
  text.layout.tables = [table];
  expect(validateInkElementV1(text).ok).toBe(true);
  for (const invalid of [
    { height: 39 },
    { borderWidth: -1 },
    { columns: 1.5 },
    { rowHeights: [0, 40] },
    { start: 5, end: 6 },
    { rowHeights: [20.0001, 19.9999] },
    { columns: 16_382 },
  ]) {
    text.layout.tables = [{ ...table, ...invalid }];
    expect(validateInkElementV1(text).ok).toBe(false);
  }
  text.layout.tables = [{ ...table, width: 0, borderWidth: 0 }];
  expect(validateInkElementV1(text).ok).toBe(true);
  text.layout.tables = [{ ...table, columns: 16_379 }];
  text.layout.math = [
    {
      start: 0,
      end: 5,
      display: false,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      paths: [{ d: "M0 0L1 1Z" }],
    },
  ];
  expect(validateInkElementV1(text).ok).toBe(false);
});
describe("native text snapshot validation", () => {
  it("accepts optional range backgrounds while retaining the strict field-style schema", () => {
    const text = textElement();
    text.ranges = [
      { start: 0, end: 5, style: { backgroundColor: null, backgroundOpacity: 0.125 } },
    ];
    text.layout.lines[0]!.runs[0]!.style = {
      backgroundColor: { type: "rgba", value: "#123456FF" },
      backgroundOpacity: 0.5,
    };
    expect(validateInkElementV1(text).ok).toBe(true);
    text.ranges[0]!.style.backgroundOpacity = 1.1;
    expect(validateInkElementV1(text).ok).toBe(false);
    text.ranges[0]!.style.backgroundOpacity = 0;
    expect(
      validateInkElementV1({ ...text, style: { ...text.style, backgroundColor: null } }).ok,
    ).toBe(false);
  });
  it("accepts bounded fractional rich text and requires version 2", () => {
    const text = textElement();
    text.ranges = [{ start: 0, end: 5, style: { bold: true, fontSize: 17.25 } }];
    text.paragraphs = [{ start: 0, alignment: "justify" }];
    expect(validateInkElementV1(text).ok).toBe(true);
    expect(validateInkSnapshotV1({ ...snapshot([text]), version: 2 }).ok).toBe(true);
    expect(validateInkSnapshotV1(snapshot([text]))).toMatchObject({
      ok: false,
      error: { code: "invalid-literal", path: "$.version" },
    });
    expect(validateInkSnapshotV1({ ...snapshot(), version: 3 }).ok).toBe(false);
  });

  it.each([
    (text: ReturnType<typeof textElement>) => {
      text.style.fontSize = 0;
    },
    (text: ReturnType<typeof textElement>) => {
      text.style.fontSize = 16.1234;
    },
    (text: ReturnType<typeof textElement>) => {
      text.ranges = [{ start: 0, end: 6, style: { bold: true } }];
    },
    (text: ReturnType<typeof textElement>) => {
      text.paragraphs = [{ start: 2, alignment: "right" }];
    },
    (text: ReturnType<typeof textElement>) => {
      text.layout.lines[0]!.baseline = 21;
    },
    (text: ReturnType<typeof textElement>) => {
      text.pivot.x = 0;
    },
    (text: ReturnType<typeof textElement>) => {
      text.layout.math = [
        {
          start: 0,
          end: 5,
          display: false,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          paths: [{ d: "<script>alert(1)</script>" }],
        },
      ];
    },
  ])("rejects invalid text geometry, formatting, and unsafe paths", (mutate) => {
    const text = textElement();
    mutate(text);
    expect(validateInkElementV1(text).ok).toBe(false);
  });

  it("validates bounded embedded font metadata without claiming binary validity", () => {
    const resource = {
      id: "font-1",
      family: "test-font",
      weight: 400,
      weightRange: [400, 700],
      style: "normal",
      mimeType: "font/woff2",
      data: "dGVzdA==",
    };
    const document = { ...snapshot(), version: 2, fontResources: [resource] };
    expect(validateInkSnapshotV1(document).ok).toBe(true);
    expect(validateInkSnapshotV1({ ...document, version: 1 }).ok).toBe(false);
    expect(validateInkSnapshotV1({ ...document, fontResources: [resource, resource] }).ok).toBe(
      false,
    );
    expect(
      validateInkSnapshotV1({
        ...document,
        fontResources: [{ ...resource, data: "http://remote" }],
      }).ok,
    ).toBe(false);
  });
});
