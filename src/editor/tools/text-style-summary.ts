import { textStyleAt, textStyleSegmentsSteps } from "../../domain/text/text-style-segments";
import type { TextElementV2, TextStyleV2, ColorV1 } from "../../domain/schema/public";
import { effectiveTextBackground } from "../../domain/geometry/text-backgrounds";
import type { MixedValue } from "../selection/structural-style";

export interface TextSelectionStyleSummary {
  readonly kind: "text";
  readonly style: { readonly [Key in keyof TextStyleV2]: MixedValue<TextStyleV2[Key]> };
  readonly alignment: MixedValue<TextElementV2["paragraphs"][number]["alignment"]>;
  readonly backgroundColor: MixedValue<ColorV1 | null>;
  readonly backgroundOpacity: MixedValue<number>;
}

export function summarizeTextStyle(elements: readonly TextElementV2[]): TextSelectionStyleSummary {
  const backgrounds: TextBackgroundValue[] = [];
  const effective = elements.flatMap((element) => effectiveTextStyles(element, backgrounds));
  const style = {} as { [Key in keyof TextStyleV2]: MixedValue<TextStyleV2[Key]> };
  for (const key of Object.keys(elements[0]!.style) as (keyof TextStyleV2)[]) {
    const values = effective.map((entry) => entry[key]);
    Object.assign(style, { [key]: commonTextValue(values) });
  }
  return {
    kind: "text",
    style,
    alignment: commonTextValue(
      elements.flatMap((element) =>
        element.paragraphs.length === 0
          ? ["left" as const]
          : element.paragraphs.map(({ alignment }) => alignment),
      ),
    ),
    backgroundColor: commonTextValue(backgrounds.map(({ color }) => color)),
    backgroundOpacity: commonTextValue(backgrounds.map(({ opacity }) => opacity)),
  };
}

export function commonTextValue<T>(values: readonly T[]): MixedValue<T> {
  const first = values[0] as T;
  return values.every((value) => {
    if (typeof first !== "object" || first === null || typeof value !== "object" || value === null)
      return Object.is(value, first);
    const left = first as unknown as { type: string; value?: string };
    const right = value as unknown as typeof left;
    return left.type === right.type && left.value === right.value;
  })
    ? first
    : "mixed";
}

export type TextBackgroundValue = ReturnType<typeof effectiveTextBackground>;

export function effectiveTextStyles(
  element: TextElementV2,
  backgrounds?: TextBackgroundValue[],
): readonly TextStyleV2[] {
  backgrounds?.push(effectiveTextBackground(element, {}));
  const sizes = baseFontSizeSegments(element);
  const styles: TextStyleV2[] = [];
  for (const line of element.layout.lines) {
    for (const run of line.runs) {
      if (!run.text.length) continue;
      backgrounds?.push(effectiveTextBackground(element, run.style ?? {}));
      styles.push({
        ...element.style,
        ...run.style,
        fontSize: sizes.length
          ? (textStyleAt(sizes, run.start).fontSize ?? element.style.fontSize)
          : element.style.fontSize,
      });
    }
  }
  if (backgrounds && element.layout.math?.length) {
    const steps = textStyleSegmentsSteps(element.ranges, element.source.length);
    let step = steps.next();
    while (!step.done) step = steps.next();
    for (const math of element.layout.math)
      backgrounds.push(effectiveTextBackground(element, textStyleAt(step.value, math.start)));
  }
  return styles.length ? styles : [element.style];
}

/** The font-size control edits the pre-heading size, while other controls reflect rendered glyphs. */
function baseFontSizeSegments(element: TextElementV2) {
  if (!element.ranges.some(({ style }) => style.fontSize !== undefined)) return [];
  const steps = textStyleSegmentsSteps(element.ranges, element.source.length);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}
