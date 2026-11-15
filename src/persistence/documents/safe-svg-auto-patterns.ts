import { hasExactAttributes, parseOpeningTag, skipWhitespace } from "./svg-tag";
import { isSafeSvgCoordinate } from "./safe-svg-transform";
import { isSafeAutoPatternTransform } from "./safe-svg-auto-paint";
import type {
  SafeAutoPaintBox,
  SafeAutoPaintReferences,
  SafeAutoPaintServer,
  SafeAutoTile,
  SafeAutoGeometryReference,
} from "./safe-svg-auto-paint";
import { sha256Hex } from "../serialization/sha256";
import type { SafeAutoVisitor } from "./safe-svg-auto-definitions";
import { AUTO_CONTRAST_MATRIX, AUTO_CONTRAST_TILE_AXIS } from "../../domain/images/auto-contrast";

type Tag = NonNullable<ReturnType<typeof parseOpeningTag>>;

const FILTER_PROGRAM =
  `<feColorMatrix type="matrix" values="${AUTO_CONTRAST_MATRIX}"/>` +
  '<feComponentTransfer><feFuncR type="discrete" tableValues="0 1"/>' +
  '<feFuncG type="discrete" tableValues="0 1"/><feFuncB type="discrete" tableValues="0 1"/>' +
  "</feComponentTransfer>";

/** Atom-local aliases may reference one admitted global server, without alias chains. */
export function parseSafeAutoPattern(
  input: string,
  start: number,
  key: string,
  references: SafeAutoPaintReferences,
  visitor?: SafeAutoVisitor,
): { next: number; tile: SafeAutoTile } | null {
  const pattern = parseOpeningTag(input, start);
  if (pattern?.name !== "pattern" || !pattern.selfClosing) return null;
  const box = parseTileBox(pattern.attributes);
  const href = pattern.attributes.get("href");
  const server = href?.startsWith("#") ? references.servers.get(href.slice(1)) : undefined;
  const paintId = `inkbook-auto-paint-${key}`;
  const transform = pattern.attributes.get("patternTransform");
  if (
    box === null ||
    server === undefined ||
    !containsBox(server.box, box) ||
    !validAlias(
      pattern,
      { id: paintId, href: `#${server.id}`, ...box, viewBox: boxList(box) },
      transform,
    )
  )
    return null;
  visitor?.open(pattern);
  references.used.add(server.id);
  return { next: pattern.next, tile: { box, paintId } };
}

/** Each global server owns one fixed filter program and its sole underlay reference. */
export function parseSafeAutoServer(
  input: string,
  start: number,
  visitor?: SafeAutoVisitor,
): { next: number; server: SafeAutoPaintServer } | null {
  const opening = parseOpeningTag(input, start);
  const box = opening === null ? null : parseTileBox(opening.attributes);
  if (box === null) return null;
  const key = sha256Hex(boxList(box));
  const filterId = `inkbook-auto-server-filter-${key}`;
  const parsedFilter = parseSafeAutoFilter(input, start, filterId, visitor);
  if (parsedFilter === null) return null;
  const pattern = parseOpeningTag(input, skipWhitespace(input, parsedFilter.next));
  const paintId = `inkbook-auto-server-paint-${key}`;
  if (
    pattern?.name !== "pattern" ||
    pattern.selfClosing ||
    pattern.attributes.has("patternTransform") ||
    !validPattern(pattern, paintId, box)
  )
    return null;
  visitor?.open(pattern);
  const use = parseOpeningTag(input, skipWhitespace(input, pattern.next));
  if (
    use?.name !== "use" ||
    !use.selfClosing ||
    !hasExactAttributes(use.attributes, {
      href: "#inkbook-auto-underlay",
      filter: `url(#${filterId})`,
    })
  )
    return null;
  visitor?.open(use);
  const cursor = skipWhitespace(input, use.next);
  if (!input.startsWith("</pattern>", cursor)) return null;
  visitor?.close();
  return { next: cursor + 10, server: { id: paintId, box } };
}

function parseSafeAutoFilter(
  input: string,
  start: number,
  filterId: string,
  visitor?: SafeAutoVisitor,
): {
  readonly next: number;
  readonly box: SafeAutoTile["box"];
  readonly filterId: string;
} | null {
  const filter = parseOpeningTag(input, start);
  const box = filter === null ? null : parseTileBox(filter.attributes);
  if (
    box === null ||
    filter?.name !== "filter" ||
    filter.selfClosing ||
    !hasExactAttributes(filter.attributes, {
      id: filterId,
      ...box,
      filterUnits: "userSpaceOnUse",
      "color-interpolation-filters": "linearRGB",
    })
  )
    return null;
  visitor?.open(filter);
  let cursor = skipWhitespace(input, filter.next);
  if (!input.startsWith(FILTER_PROGRAM, cursor)) return null;
  visitAutoMarkup(FILTER_PROGRAM, visitor);
  cursor = skipWhitespace(input, cursor + FILTER_PROGRAM.length);
  if (!input.startsWith("</filter>", cursor)) return null;
  visitor?.close();
  return { next: cursor + 9, box, filterId };
}

function parseTileBox(attributes: ReadonlyMap<string, string>): SafeAutoPaintBox | null {
  if (!["x", "y", "width", "height"].every((name) => isSafeSvgCoordinate(attributes.get(name))))
    return null;
  const width = Number(attributes.get("width"));
  const height = Number(attributes.get("height"));
  if (
    width <= 0 ||
    height <= 0 ||
    width > AUTO_CONTRAST_TILE_AXIS ||
    height > AUTO_CONTRAST_TILE_AXIS
  )
    return null;
  return {
    x: attributes.get("x")!,
    y: attributes.get("y")!,
    width: attributes.get("width")!,
    height: attributes.get("height")!,
  };
}

function boxList(box: SafeAutoPaintBox): string {
  return `${box.x} ${box.y} ${box.width} ${box.height}`;
}

function validAlias(
  tag: Tag,
  expected: Readonly<Record<string, string>>,
  transform: string | undefined,
): boolean {
  return (
    (transform === undefined || isSafeAutoPatternTransform(transform)) &&
    hasExactAttributes(tag.attributes, {
      ...expected,
      ...(transform === undefined ? {} : { patternTransform: transform }),
    })
  );
}

function containsBox(outer: SafeAutoPaintBox, inner: SafeAutoPaintBox): boolean {
  const units = (value: string): number => Math.round(Number(value) * 1000);
  return (
    units(inner.x) >= units(outer.x) &&
    units(inner.y) >= units(outer.y) &&
    units(inner.x) + units(inner.width) <= units(outer.x) + units(outer.width) &&
    units(inner.y) + units(inner.height) <= units(outer.y) + units(outer.height)
  );
}

function validPattern(tag: Tag, id: string, box: SafeAutoTile["box"]): boolean {
  const transform = tag.attributes.get("patternTransform");
  return (
    (transform === undefined || isSafeAutoPatternTransform(transform)) &&
    hasExactAttributes(tag.attributes, {
      id,
      patternUnits: "userSpaceOnUse",
      patternContentUnits: "userSpaceOnUse",
      ...box,
      viewBox: `${box.x} ${box.y} ${box.width} ${box.height}`,
      ...(transform === undefined ? {} : { patternTransform: transform }),
    })
  );
}

export function visitAutoMarkup(markup: string, visitor: SafeAutoVisitor | undefined): void {
  if (visitor === undefined) return;
  let cursor = 0;
  while (cursor < markup.length) {
    if (markup.startsWith("</", cursor)) {
      visitor.close();
      cursor = markup.indexOf(">", cursor) + 1;
    } else {
      const tag = parseOpeningTag(markup, cursor)!;
      visitor.open(tag);
      cursor = tag.next;
    }
  }
}

export function parseSafeAutoTile(
  input: string,
  start: number,
  tile: SafeAutoTile,
  geometry: SafeAutoGeometryReference,
  visitor?: SafeAutoVisitor,
): number | null {
  const svg = parseOpeningTag(input, start);
  const { box } = tile;
  if (
    svg?.name !== "svg" ||
    svg.selfClosing ||
    !hasExactAttributes(svg.attributes, {
      ...box,
      viewBox: `${box.x} ${box.y} ${box.width} ${box.height}`,
      overflow: "hidden",
      preserveAspectRatio: "none",
    })
  )
    return null;
  visitor?.open(svg);
  const use = parseOpeningTag(input, skipWhitespace(input, svg.next));
  if (
    use?.name !== "use" ||
    !use.selfClosing ||
    !hasExactAttributes(use.attributes, {
      href: `#${geometry.id}`,
      fill: geometry.paint === "stroke" ? "none" : `url(#${tile.paintId})`,
      stroke: geometry.paint === "fill" ? "none" : `url(#${tile.paintId})`,
    })
  )
    return null;
  visitor?.open(use);
  const cursor = skipWhitespace(input, use.next);
  if (!input.startsWith("</svg>", cursor)) return null;
  visitor?.close();
  return cursor + 6;
}
