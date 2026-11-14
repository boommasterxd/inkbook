import { decodeMetadataTextSteps } from "./safe-svg-metadata";
import { parseCanonicalSvgDecimal, parseCanonicalSvgOpacity } from "./svg-number";
import { parseOpeningTag, skipWhitespace } from "./svg-tag";
import { isSafeSvgCoordinate, isSafeSvgRotation } from "./safe-svg-transform";
import { DOCUMENT_PALETTE } from "./svg-theme";

export const MAXIMUM_TEXT_MARKUP_CHARACTERS = 16 * 1024 * 1024;
const FONT_FAMILY = /^inkbook-[a-z][a-z0-9-]{0,95}$/u;
const PAINT = /^#[0-9A-F]{8}$/u;
const OPTIONAL_SPAN_ATTRIBUTES = new Set(["class", "textLength", "lengthAdjust"]);
const REQUIRED_SPAN_ATTRIBUTES = [
  "x",
  "y",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-decoration",
  "fill",
  "fill-opacity",
];

export interface SafeSvgTextVisitor {
  open(tag: NonNullable<ReturnType<typeof parseOpeningTag>>): void;
  text?(value: string): void;
  close(): void;
  unadjustedText?(tag: NonNullable<ReturnType<typeof parseOpeningTag>>, text: string): void;
}

function validTextAttributes(attributes: ReadonlyMap<string, string>): boolean {
  if ([...attributes.keys()].some((name) => name !== "transform" && name !== "xml:space"))
    return false;
  const space = attributes.get("xml:space");
  if (space !== undefined && space !== "preserve") return false;
  const transform = attributes.get("transform");
  return transform === undefined || isSafeSvgRotation(transform);
}

function validSpanAttributes(attributes: ReadonlyMap<string, string>): boolean {
  if (
    REQUIRED_SPAN_ATTRIBUTES.some((name) => !attributes.has(name)) ||
    [...attributes.keys()].some(
      (name) => !OPTIONAL_SPAN_ATTRIBUTES.has(name) && !REQUIRED_SPAN_ATTRIBUTES.includes(name),
    )
  )
    return false;
  const size = parseCanonicalSvgDecimal(attributes.get("font-size"), 4096);
  const className = attributes.get("class");
  return (
    isSafeSvgCoordinate(attributes.get("x")) &&
    isSafeSvgCoordinate(attributes.get("y")) &&
    FONT_FAMILY.test(attributes.get("font-family")!) &&
    size !== null &&
    size > 0 &&
    ["400", "700"].includes(attributes.get("font-weight")!) &&
    ["normal", "italic"].includes(attributes.get("font-style")!) &&
    ["none", "underline", "line-through", "underline line-through"].includes(
      attributes.get("text-decoration")!,
    ) &&
    PAINT.test(attributes.get("fill")!) &&
    validTextLengthPair(attributes) &&
    parseCanonicalSvgOpacity(attributes.get("fill-opacity")) !== null &&
    (className === undefined ||
      (className === "inkbook-theme-fill" &&
        attributes.get("fill") === DOCUMENT_PALETTE.light.text))
  );
}

function validTextLengthPair(attributes: ReadonlyMap<string, string>): boolean {
  const textLength = attributes.get("textLength");
  const adjustment = attributes.get("lengthAdjust");
  if (textLength === undefined) return adjustment === undefined;
  const length = parseCanonicalSvgDecimal(textLength, 1_000_000);
  return length !== null && length > 0 && adjustment === "spacingAndGlyphs";
}

/** Visitor output remains provisional until complete validation returns a non-null offset. */
export function* validateTextElementSteps(
  input: string,
  start: number,
  visitor?: SafeSvgTextVisitor,
): Generator<void, number | null> {
  const tag = parseOpeningTag(input, start);
  if (
    tag === null ||
    tag.name !== "text" ||
    tag.selfClosing ||
    !validTextAttributes(tag.attributes)
  )
    return null;
  visitor?.open(tag);
  let cursor = skipWhitespace(input, tag.next);
  let spans = 0;
  let characters = 0;
  while (!input.startsWith("</text>", cursor)) {
    const span = parseOpeningTag(input, cursor);
    if (
      span === null ||
      span.name !== "tspan" ||
      span.selfClosing ||
      !validSpanAttributes(span.attributes)
    )
      return null;
    const end = input.indexOf("</tspan>", span.next);
    if (end < 0 || end - start > MAXIMUM_TEXT_MARKUP_CHARACTERS) return null;
    const decoded = yield* decodeMetadataTextSteps(input.slice(span.next, end));
    if (decoded === null || !validXmlCharacters(decoded.text)) return null;
    characters += decoded.text.length;
    if (++spans > 16_384 || characters > 200_000) return null;
    visitRun(visitor, span, decoded.text);
    cursor = skipWhitespace(input, end + 8);
    yield;
  }
  if (cursor + 7 - start > MAXIMUM_TEXT_MARKUP_CHARACTERS) return null;
  visitor?.close();
  return cursor + 7;
}

function visitRun(
  visitor: SafeSvgTextVisitor | undefined,
  tag: NonNullable<ReturnType<typeof parseOpeningTag>>,
  text: string,
): void {
  if (text.length > 0 && !tag.attributes.has("textLength")) visitor?.unadjustedText?.(tag, text);
  visitor?.open(tag);
  visitor?.text?.(text);
  visitor?.close();
}

function validXmlCharacters(text: string): boolean {
  if (/[\uD800-\uDFFF\uFFFE\uFFFF]/u.test(text)) return false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return false;
  }
  return true;
}
