import type { ImageResourceV3 } from "../../domain/schema/public";
import { FILE_SCHEMA_LIMITS } from "../../domain/schema/public";
import { parseSafeImageInstance } from "./safe-svg-images";
import { hasExactAttributes, parseOpeningTag, skipWhitespace } from "./svg-tag";
import { serializeSvgNumber } from "./svg-number";

export interface SafeAutoVisitor {
  open(tag: NonNullable<ReturnType<typeof parseOpeningTag>>): void;
  close(): void;
  text?(value: string): void;
}

interface AutoDefinitionOptions {
  readonly height: number;
  readonly resources: readonly ImageResourceV3[];
  readonly visitor?: SafeAutoVisitor;
  readonly exhausted?: () => boolean;
}

export function* parseSafeAutoDefinitionsSteps(
  input: string,
  start: number,
  options: AutoDefinitionOptions,
): Generator<void, number | null> {
  const defs = parseOpeningTag(input, start);
  if (!isContainer(defs, "defs", { id: "inkbook-auto" })) return null;
  options.visitor?.open(defs!);
  const height = serializeSvgNumber(options.height);
  const svg = parseOpeningTag(input, skipWhitespace(input, defs!.next));
  if (
    !isContainer(svg, "svg", {
      id: "inkbook-auto-underlay",
      x: "0",
      y: "0",
      width: "2048.6",
      height,
      viewBox: `0 0 2048.6 ${height}`,
      overflow: "hidden",
      preserveAspectRatio: "none",
    })
  )
    return null;
  options.visitor?.open(svg!);
  const page = parseOpeningTag(input, skipWhitespace(input, svg!.next));
  if (
    page?.name !== "path" ||
    !page.selfClosing ||
    !hasExactAttributes(page.attributes, {
      d: `M 0 0 L 2048.6 0 L 2048.6 ${height} L 0 ${height} Z`,
      class: "inkbook-theme-page",
      fill: "#F6F6F6FF",
    })
  )
    return null;
  options.visitor?.open(page);
  const endImages = yield* parseUnderlayImagesSteps(
    input,
    skipWhitespace(input, page.next),
    options,
  );
  if (endImages === null) return null;
  options.visitor?.close();
  const cursor = skipWhitespace(input, endImages + 6);
  if (!input.startsWith("</defs>", cursor)) return null;
  options.visitor?.close();
  return cursor + 7;
}

function* parseUnderlayImagesSteps(
  input: string,
  start: number,
  options: AutoDefinitionOptions,
): Generator<void, number | null> {
  const resources = new Map(options.resources.map((resource) => [resource.id, resource]));
  let cursor = start;
  let images = 0;
  while (!input.startsWith("</svg>", cursor)) {
    const image = parseSafeImageInstance(input, cursor, resources, true);
    if (image === null || ++images > FILE_SCHEMA_LIMITS.elements) return null;
    for (const tag of image.tags) options.visitor?.open(tag);
    options.visitor?.close();
    options.visitor?.close();
    cursor = skipWhitespace(input, image.next);
    if (options.exhausted?.() ?? true) yield;
  }
  return cursor;
}

function isContainer(
  tag: ReturnType<typeof parseOpeningTag>,
  name: string,
  attributes: Readonly<Record<string, string>>,
): boolean {
  return tag?.name === name && !tag.selfClosing && hasExactAttributes(tag.attributes, attributes);
}
