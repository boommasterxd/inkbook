import { changeWholeTextMark } from "./text-mark-style";
import type { InkElementV1, TextElementV2, TextStyleV2 } from "../../domain/schema/public";
import type { TextDefaultsV2 } from "../../domain/settings/types";
import { textStyleKey, type StyleChange } from "./style-change-validation";

export function textStylePatch(change: StyleChange): Partial<TextDefaultsV2> {
  if (change.property === "color" || change.property === "opacity")
    return { [change.property]: structuredClone(change.value) };
  if (change.property === "fill-color") return { backgroundColor: structuredClone(change.value) };
  if (change.property === "fill-opacity") return { backgroundOpacity: change.value };
  return change.property.startsWith("text-")
    ? { [textStyleKey(change.property)]: structuredClone(change.value) }
    : {};
}

export function changeTextElement(element: TextElementV2, change: StyleChange): InkElementV1 {
  const patch = textStylePatch(change);
  const entries = Object.entries(patch);
  if (entries.length === 0)
    throw new RangeError(`Style property ${change.property} does not apply to text.`);
  const [key, value] = entries[0]!;
  if (key === "alignment") {
    const paragraphs =
      element.paragraphs.length === 0
        ? [{ start: 0, alignment: "left" as const }]
        : element.paragraphs;
    if (paragraphs.every((paragraph) => paragraph.alignment === value)) return element;
    return {
      ...element,
      paragraphs: paragraphs.map((paragraph) => ({
        ...paragraph,
        alignment: value as TextDefaultsV2["alignment"],
      })),
    };
  }
  if (key === "backgroundColor" || key === "backgroundOpacity") {
    return changeTextBackground(element, key, value);
  }
  if (key === "bold" || key === "italic" || key === "strikethrough") {
    return changeWholeTextMark(element, key, value as boolean);
  }
  const styleKey = key as keyof TextStyleV2;
  if (
    equal(element.style[styleKey], value) &&
    element.ranges.every(
      (range) => range.style[styleKey] === undefined || equal(range.style[styleKey], value),
    )
  )
    return element;
  const ranges = element.ranges.flatMap((range) => {
    const style = { ...range.style };
    delete style[styleKey];
    return Object.keys(style).length === 0 ? [] : [{ ...range, style }];
  });
  return { ...element, style: { ...element.style, [key]: value }, ranges };
}

function changeTextBackground(
  element: TextElementV2,
  key: "backgroundColor" | "backgroundOpacity",
  value: unknown,
): TextElementV2 {
  let changed = !equal(element[key], value);
  const ranges = element.ranges.flatMap((range) => {
    if (range.style[key] === undefined) return [range];
    changed = true;
    const style = { ...range.style };
    delete style[key];
    return Object.keys(style).length ? [{ ...range, style }] : [];
  });
  const lines = element.layout.lines.map((line) => {
    let lineChanged = false;
    const runs = line.runs.map((run) => {
      if (run.style?.[key] === undefined) return run;
      changed = lineChanged = true;
      const { style: previous, ...fields } = run;
      const style = { ...previous };
      delete style[key];
      return Object.keys(style).length ? { ...fields, style } : fields;
    });
    return lineChanged ? { ...line, runs } : line;
  });
  return changed
    ? { ...element, [key]: value, ranges, layout: { ...element.layout, lines } }
    : element;
}

export function textDefaultsMatch(values: TextDefaultsV2, change: StyleChange): boolean {
  return Object.entries(textStylePatch(change)).every(([key, value]) =>
    equal(values[key as keyof TextDefaultsV2], value),
  );
}

function equal(left: unknown, right: unknown): boolean {
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null)
    return Object.is(left, right);
  const a = left as { type: string; value?: string };
  const b = right as typeof a;
  return a.type === b.type && a.value === b.value;
}
