import { FILE_SCHEMA_LIMITS } from "../../domain/schema/public";
import type { ImageResourceV3 } from "../../domain/schema/public";
import { IMAGE_LIMITS } from "../../domain/images/image-limits";
import { validateImageResourceSteps } from "../images/image-resources";
import { hasExactAttributes, parseOpeningTag, skipWhitespace } from "./svg-tag";
import { isSafeSvgCoordinate, isSafeSvgRotation } from "./safe-svg-transform";

const DATA_SLICE = 16 * 1024;
const IMAGE_PREFIX =
  /^<image id="inkbook-image-([0-9a-f]{64})" width="([1-9]\d{0,4})" height="([1-9]\d{0,4})" href="data:(image\/(?:png|jpeg|webp));base64,/u;

export function hasSafeImageBand(input: string, version: number): boolean {
  return (
    (version >= 3 && version <= 5) ||
    (version > 5 && input.includes('<g id="inkbook-images-band">'))
  );
}

export interface SafeSvgImages {
  readonly resources: readonly ImageResourceV3[];
  readonly next: number;
}

/** Definitions contain raster bytes once. Only these leaf IDs may be referenced. */
export function* parseSafeImageDefinitionsSteps(
  input: string,
  start: number,
  validateResource = true,
): Generator<void, SafeSvgImages | null> {
  const tag = parseOpeningTag(input.slice(start, start + 64), 0);
  if (
    tag?.name !== "defs" ||
    tag.selfClosing ||
    !hasExactAttributes(tag.attributes, { id: "inkbook-images" })
  )
    return null;
  const resources: ImageResourceV3[] = [];
  const ids = new Set<string>();
  let bytes = 0;
  let pixels = 0;
  let cursor = skipWhitespace(input, start + tag.next);
  while (!input.startsWith("</defs>", cursor)) {
    const prefix = IMAGE_PREFIX.exec(input.slice(cursor, cursor + 256));
    if (prefix === null || resources.length === IMAGE_LIMITS.resources || ids.has(prefix[1]!))
      return null;
    const dataStart = cursor + prefix[0].length;
    const end = yield* findDataEndSteps(input, dataStart);
    if (end < 0 || !input.startsWith('"/>', end)) return null;
    const resource: ImageResourceV3 = Object.freeze({
      id: prefix[1]!,
      width: Number(prefix[2]),
      height: Number(prefix[3]),
      mimeType: prefix[4] as ImageResourceV3["mimeType"],
      data: input.slice(dataStart, end),
    });
    pixels += resource.width * resource.height;
    if (pixels > IMAGE_LIMITS.documentPixels) return null;
    if (validateResource) {
      try {
        yield* validateImageResourceSteps(resource);
      } catch {
        return null;
      }
    }
    bytes +=
      (resource.data.length / 4) * 3 -
      (resource.data.endsWith("==") ? 2 : resource.data.endsWith("=") ? 1 : 0);
    if (bytes > IMAGE_LIMITS.documentBytes) return null;
    resources.push(resource);
    ids.add(resource.id);
    cursor = skipWhitespace(input, end + 3);
  }
  if (resources.length === 0) return null;
  return { resources, next: cursor + 7 };
}

function* findDataEndSteps(input: string, start: number): Generator<void, number> {
  const limit = Math.min(input.length, start + Math.ceil(IMAGE_LIMITS.resourceBytes / 3) * 4 + 1);
  for (let cursor = start; cursor < limit; cursor += DATA_SLICE) {
    const quote = input.slice(cursor, Math.min(cursor + DATA_SLICE, limit)).indexOf('"');
    if (quote >= 0) return cursor + quote;
    yield;
  }
  return -1;
}

export interface SafeImageInstance {
  readonly tags: readonly NonNullable<ReturnType<typeof parseOpeningTag>>[];
  readonly next: number;
  readonly minY: number;
  readonly maxY: number;
}

/** A fixed three-node grammar cannot introduce external or cyclic references. */
export function parseSafeImageInstance(
  input: string,
  start: number,
  resources: ReadonlyMap<string, Pick<ImageResourceV3, "width" | "height">>,
  allowContrastOverride = false,
): SafeImageInstance | null {
  const source = input.slice(start, start + 4096);
  const parsed = parseImageInstanceMarkup(source, resources, allowContrastOverride);
  return parsed === null ? null : { ...parsed, next: start + parsed.next };
}

function parseImageInstanceMarkup(
  input: string,
  resources: ReadonlyMap<string, Pick<ImageResourceV3, "width" | "height">>,
  allowContrastOverride: boolean,
): SafeImageInstance | null {
  const group = parseOpeningTag(input, 0);
  if (!isImageTransformGroup(group)) return null;
  const svg = parseOpeningTag(input, skipWhitespace(input, group.next));
  if (svg?.name !== "svg" || svg.selfClosing || !validImageViewport(svg.attributes)) return null;
  const use = parseOpeningTag(input, skipWhitespace(input, svg.next));
  if (use === null || !validImageLeaf(use, svg, resources, allowContrastOverride)) return null;
  let cursor = skipWhitespace(input, use.next);
  if (!input.startsWith("</svg>", cursor)) return null;
  cursor = skipWhitespace(input, cursor + 6);
  if (!input.startsWith("</g>", cursor)) return null;
  return {
    tags: [group, svg, use],
    next: cursor + 4,
    ...imageVerticalBounds(group.attributes.get("transform")!, svg.attributes),
  };
}

function validImageLeaf(
  leaf: NonNullable<ReturnType<typeof parseOpeningTag>>,
  viewport: NonNullable<ReturnType<typeof parseOpeningTag>>,
  resources: ReadonlyMap<string, Pick<ImageResourceV3, "width" | "height">>,
  allowContrastOverride: boolean,
): boolean {
  if (!leaf.selfClosing) return false;
  if (allowContrastOverride && leaf.name === "rect") {
    const [x, y, width, height] = viewport.attributes.get("viewBox")!.split(" ");
    const fill = leaf.attributes.get("fill");
    return (
      (fill === "#000000FF" || fill === "#FFFFFFFF") &&
      hasExactAttributes(leaf.attributes, { x: x!, y: y!, width: width!, height: height!, fill }) &&
      validCrop(viewport.attributes.get("viewBox")!, {
        width: IMAGE_LIMITS.resourceAxis,
        height: IMAGE_LIMITS.resourceAxis,
      })
    );
  }
  if (leaf.name !== "use" || leaf.attributes.size !== 1) return false;
  const href = leaf.attributes.get("href");
  const resource = href?.startsWith("#inkbook-image-") ? resources.get(href.slice(15)) : undefined;
  return resource !== undefined && validCrop(viewport.attributes.get("viewBox")!, resource);
}

function validImageViewport(attributes: ReadonlyMap<string, string>): boolean {
  if (
    attributes.size !== 7 ||
    attributes.get("overflow") !== "hidden" ||
    attributes.get("preserveAspectRatio") !== "none"
  )
    return false;
  if (!["x", "y", "width", "height"].every((name) => isSafeSvgCoordinate(attributes.get(name))))
    return false;
  return (
    Number(attributes.get("width")) > 0 &&
    Number(attributes.get("height")) > 0 &&
    attributes.has("viewBox")
  );
}

function validCrop(value: string, resource: Pick<ImageResourceV3, "width" | "height">): boolean {
  const values = value.split(" ");
  if (
    values.length !== 4 ||
    !values.every((part) => isSafeSvgCoordinate(part, IMAGE_LIMITS.resourceAxis))
  )
    return false;
  const [x, y, width, height] = values.map(Number) as [number, number, number, number];
  return (
    x >= 0 &&
    y >= 0 &&
    width > 0 &&
    height > 0 &&
    x + width <= resource.width &&
    y + height <= resource.height
  );
}

function imageVerticalBounds(
  transform: string,
  attributes: ReadonlyMap<string, string>,
): { minY: number; maxY: number } {
  const [angle, pivotX, pivotY] = transform.slice(7, -1).split(" ").map(Number) as [
    number,
    number,
    number,
  ];
  const x = Number(attributes.get("x"));
  const y = Number(attributes.get("y"));
  const width = Number(attributes.get("width"));
  const height = Number(attributes.get("height"));
  const radians = (angle * Math.PI) / 180;
  const ys = [
    [x, y],
    [x + width, y],
    [x, y + height],
    [x + width, y + height],
  ].map(
    ([px, py]) => pivotY + (px! - pivotX) * Math.sin(radians) + (py! - pivotY) * Math.cos(radians),
  );
  return { minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function isImageTransformGroup(
  tag: ReturnType<typeof parseOpeningTag>,
): tag is NonNullable<ReturnType<typeof parseOpeningTag>> {
  return (
    tag !== null &&
    tag.name === "g" &&
    !tag.selfClosing &&
    tag.attributes.size === 1 &&
    isSafeSvgRotation(tag.attributes.get("transform") ?? "")
  );
}

export function* parseSafeImageBandSteps(
  input: string,
  start: number,
  imageResources: readonly ImageResourceV3[],
  totals: { groups: number },
  deadlineExceeded?: () => boolean,
): Generator<void, { next: number; range: { start: number; end: number } } | null> {
  const group = parseOpeningTag(input, start);
  if (
    group?.name !== "g" ||
    group.selfClosing ||
    !hasExactAttributes(group.attributes, { id: "inkbook-images-band" })
  )
    return null;
  const contentStart = group.next;
  const resources = new Map(imageResources.map((resource) => [resource.id, resource]));
  let cursor = skipWhitespace(input, contentStart);
  while (!input.startsWith("</g>", cursor)) {
    const image = parseSafeImageInstance(input, cursor, resources);
    if (image === null || ++totals.groups > FILE_SCHEMA_LIMITS.elements) return null;
    cursor = skipWhitespace(input, image.next);
    if (deadlineExceeded?.() === true) yield;
  }
  return { next: cursor + 4, range: { start: contentStart, end: cursor } };
}
