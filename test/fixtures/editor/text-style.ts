import {
  canonicalizeGeometryNumber,
  type TextElementV2,
  type TextStyleV2,
} from "../../../src/domain/schema/public";
import { parseTextMarkdown } from "../domain/text-source";
import { layoutTextMarkdown } from "../../../src/rendering/text/text-layout";
import { createTestWorkScheduler } from "../persistence/work-scheduler";

/** Keeps source, ranges and the persisted visible styles coherent through the real layout path. */
export async function layoutTextElement(element: TextElementV2): Promise<TextElementV2> {
  const document = parseTextMarkdown(element.source, {
    style: element.style,
    ranges: element.ranges,
    paragraphs: element.paragraphs,
  });
  const result = await layoutTextMarkdown(
    { document, width: element.width, style: element.style },
    {
      scheduler: createTestWorkScheduler(),
      measure: {
        measure: (text: string, style: TextStyleV2) => ({
          width: Array.from(text).length * style.fontSize * 0.5,
          ascent: style.fontSize * 0.8,
          descent: style.fontSize * 0.2,
        }),
      },
    },
  );
  return {
    ...element,
    ...result,
    pivot: {
      x: canonicalizeGeometryNumber(element.x + element.width / 2),
      y: canonicalizeGeometryNumber(element.y + result.height / 2),
    },
  };
}
