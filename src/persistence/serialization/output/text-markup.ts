import type { ColorV1, TextElementV2, TextStyleV2 } from "../../../domain/schema/public";
import {
  textBackgroundBoxPath,
  textBackgroundRadius,
} from "../../../domain/geometry/rounded-background-path";
import { buildClosedShapePath } from "../../../domain/geometry/element-path";
import { fontCssFamily } from "../../fonts/font-resources";
import { DOCUMENT_PALETTE } from "../../documents/svg-theme";
import { serializeSvgNumber as number, serializeSvgOpacity } from "../../documents/svg-number";
import { escapeXmlText } from "../../documents/xml-text";
import { textStyleAt, textStyleSegmentsSteps } from "../../../domain/text/text-style-segments";
import { fontResourceCssFamily } from "../../../domain/text/font-family";
import { textBackgroundGeometrySteps } from "../../../domain/geometry/text-backgrounds";
import { textTableGridPathSteps } from "../../../domain/geometry/text-table-grid-path";

export interface TextMarkupFragment {
  readonly text: string;
  readonly legacyOptional?: true;
  readonly legacyText?: string;
  readonly legacyTexts?: readonly [string, string, string];
}

export function* serializeTextMarkup(element: TextElementV2): Iterable<string> {
  for (const fragment of serializeTextMarkupFragments(element)) yield fragment.text;
}

export function* serializeTextMarkupFragments(
  element: TextElementV2,
  compareLegacyBackground = false,
): Iterable<TextMarkupFragment> {
  const rotation = rotationTransform(element);
  if (compareLegacyBackground) yield* comparableBackgroundFragments(element, rotation);
  else {
    yield* serializeBackgroundFragments(element, rotation);
    yield { text: "<text" };
  }
  yield { text: ` xml:space="preserve"${rotation === "" ? "" : ` transform="${rotation}"`}>` };
  for (const line of element.layout.lines) {
    for (const run of line.runs) {
      const style = { ...element.style, ...run.style };
      const text = run.text;
      const x = number(element.x + line.x + run.x);
      const y = number(element.y + line.y + line.baseline);
      yield { text: `<tspan x="${x}" y="${y}"${styleAttributes(style, run.fontResourceId)}` };
      if (text.length > 0 && run.width > 0)
        yield {
          text: ` textLength="${number(run.width)}" lengthAdjust="spacingAndGlyphs"`,
          legacyOptional: true,
        };
      yield { text: ">" };
      for (let start = 0; start < text.length; start += 16 * 1024) {
        yield { text: escapeXmlText(text.slice(start, start + 16 * 1024)) };
      }
      yield { text: "</tspan>" };
    }
  }
  yield { text: "</text>" };
  yield* serializeTableFragments(element, rotation);
  if (!element.layout.math?.length) return;
  const styleSteps = textStyleSegmentsSteps(element.ranges, element.source.length);
  let step = styleSteps.next();
  while (!step.done) {
    yield { text: "" };
    step = styleSteps.next();
  }
  const segments = step.value;
  for (const math of element.layout.math ?? []) {
    const style = { ...element.style, ...textStyleAt(segments, math.start) };
    const transform = `${rotation === "" ? "" : `${rotation} `}translate(${number(element.x + math.x)} ${number(element.y + math.y)})`;
    for (const path of math.paths) {
      yield {
        text: `<path d="${path.d}"${paintAttributes(style.color, style.opacity)}${path.fillRule === undefined ? "" : ` fill-rule="${path.fillRule}"`} transform="${transform}"/>`,
      };
    }
  }
}

function* serializeTableFragments(
  element: TextElementV2,
  rotation: string,
): Iterable<TextMarkupFragment> {
  for (const table of element.layout.tables ?? []) {
    const steps = textTableGridPathSteps(table);
    let step = steps.next();
    while (!step.done) {
      yield { text: "" };
      step = steps.next();
    }
    if (step.value === "") continue;
    const transform = `${rotation === "" ? "" : `${rotation} `}translate(${number(element.x)} ${number(element.y)})`;
    yield {
      text: `<path d="${step.value}"${paintAttributes(element.style.color, element.style.opacity)} transform="${transform}"/>`,
    };
  }
}

function* serializeBackgroundFragments(
  element: TextElementV2,
  rotation: string,
  roundCorners = true,
  radius = textBackgroundRadius(element, element.style.fontSize),
  mergeBaseContours = true,
): Iterable<TextMarkupFragment> {
  const steps = textBackgroundGeometrySteps(
    element,
    undefined,
    roundCorners,
    radius,
    mergeBaseContours,
  );
  let background = steps.next();
  while (!background.done) {
    yield { text: "" };
    background = steps.next();
  }
  const transform = rotation === "" ? "" : ` transform="${rotation} translate(0 0)"`;
  if (element.backgroundColor !== null && element.backgroundOpacity > 0) {
    const d =
      background.value.basePath ??
      (roundCorners ? textBackgroundBoxPath(element, radius) : legacyBoxPath(element));
    if (d !== "")
      yield {
        text: `<path d="${d}"${paintAttributes(element.backgroundColor, element.backgroundOpacity)}${!roundCorners && background.value.basePath === undefined ? "" : transform}/>`,
      };
  }
  for (const paint of background.value.paints)
    yield {
      text: `<path d="${paint.d}"${paintAttributes(paint.color, paint.opacity)}${transform}/>`,
    };
}

function* comparableBackgroundFragments(
  element: TextElementV2,
  rotation: string,
): Iterable<TextMarkupFragment> {
  let text = "";
  let legacyText = "";
  let squareText = "";
  let partitionedText = "";
  for (const fragment of serializeBackgroundFragments(element, rotation)) {
    text += fragment.text;
    yield { text: "" };
  }
  for (const fragment of serializeBackgroundFragments(element, rotation, true, 2, false)) {
    legacyText += fragment.text;
    yield { text: "" };
  }
  for (const fragment of serializeBackgroundFragments(element, rotation, false, undefined, false)) {
    squareText += fragment.text;
    yield { text: "" };
  }
  for (const fragment of serializeBackgroundFragments(element, rotation, true, undefined, false)) {
    partitionedText += fragment.text;
    yield { text: "" };
  }
  // The shared next tag prevents either alternative from being a prefix of the other.
  yield {
    text: `${text}<text`,
    legacyTexts: [`${legacyText}<text`, `${squareText}<text`, `${partitionedText}<text`],
  };
}

function legacyBoxPath(element: TextElementV2): string {
  return buildClosedShapePath({
    ...element,
    kind: "rectangle",
    style: {
      outlineColor: element.backgroundColor!,
      outlineWidth: 1,
      outlineOpacity: 0,
      outlineStyle: "solid",
      fillColor: element.backgroundColor,
      fillOpacity: element.backgroundOpacity,
    },
  });
}

function rotationTransform(element: TextElementV2): string {
  return element.rotation === 0
    ? ""
    : `rotate(${number(element.rotation)} ${number(element.pivot.x)} ${number(element.pivot.y)})`;
}

function styleAttributes(style: TextStyleV2, resourceId?: string): string {
  const decoration =
    [style.underline ? "underline" : "", style.strikethrough ? "line-through" : ""]
      .filter(Boolean)
      .join(" ") || "none";
  const family =
    resourceId === undefined ? fontCssFamily(style.fontFamily) : fontResourceCssFamily(resourceId);
  return ` font-family="${family}" font-size="${number(style.fontSize)}" font-weight="${style.bold ? 700 : 400}" font-style="${style.italic ? "italic" : "normal"}" text-decoration="${decoration}"${paintAttributes(style.color, style.opacity)}`;
}

function paintAttributes(color: ColorV1, opacity: number): string {
  return `${color.type === "theme-text" ? ' class="inkbook-theme-fill"' : ""} fill="${color.type === "theme-text" ? DOCUMENT_PALETTE.light.text : color.value}" fill-opacity="${serializeSvgOpacity(opacity)}"`;
}
