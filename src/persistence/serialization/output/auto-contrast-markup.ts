import type { Bounds } from "../../../domain/geometry/primitives";
import type { InkElementV1 } from "../../../domain/schema/public";
import { parseOpeningTag } from "../../documents/svg-tag";
import { sha256Hex } from "../sha256";
import { autoPaintTiles, autoTileAttributes, autoTileViewBox } from "./auto-contrast-tiles";
import { inverseAutoPaintTransform } from "./auto-contrast-transforms";
import { autoPaintServer, type AutoPaintServerRegistry } from "./auto-contrast-servers";
import {
  autoTextRunBounds,
  autoTrailingTextPathBounds,
  nextAutoPaintBounds,
} from "./auto-contrast-text-bounds";

type Tag = NonNullable<ReturnType<typeof parseOpeningTag>>;
type AutoClass = "inkbook-theme-fill" | "inkbook-theme-stroke" | "inkbook-theme-stroke-fill";

interface PaintContext {
  readonly id: string;
  readonly bounds: Bounds;
  readonly parents: string[];
  readonly runBounds: Iterator<Bounds> | undefined;
  readonly followingPathBounds: Iterator<Bounds> | undefined;
  readonly servers: Pick<AutoPaintServerRegistry, "add"> | undefined;
  afterText: boolean;
  atom: number;
}

/** Derived presentation depends only on geometry; image edits change the shared underlay. */
export function* autoElementMarkupFragments(
  element: InkElementV1,
  markup: string,
  bounds: Bounds,
  servers?: Pick<AutoPaintServerRegistry, "add">,
): Iterable<string> {
  if (element.kind === "image" || !markup.includes('class="inkbook-theme-')) {
    yield markup;
    return;
  }
  const context: PaintContext = {
    id: sha256Hex(element.id),
    bounds,
    parents: [],
    atom: 0,
    runBounds: element.kind === "text" ? autoTextRunBounds(element) : undefined,
    followingPathBounds: element.kind === "text" ? autoTrailingTextPathBounds(element) : undefined,
    afterText: false,
    servers,
  };
  const emittedGroups: boolean[] = [];
  let cursor = 0;
  while (cursor < markup.length) {
    if (markup.startsWith("</g>", cursor)) {
      if (emittedGroups.pop()) yield "</g>";
      context.parents.pop();
      cursor += 4;
      continue;
    }
    const tag = parseOpeningTag(markup, cursor);
    if (tag === null) throw new Error("Invalid canonical ink markup.");
    if (tag.name === "g") {
      context.parents.push(tag.attributes.get("transform") ?? "");
      const opacity = tag.attributes.get("opacity");
      emittedGroups.push(opacity !== undefined);
      if (opacity !== undefined) yield `<g opacity="${opacity}">`;
      cursor = tag.next;
    } else if (tag.name === "text") {
      const end = markup.indexOf("</text>", tag.next);
      if (end < 0) throw new Error("Invalid canonical text markup.");
      yield* textAtoms(markup, tag, end, context);
      context.afterText = true;
      cursor = end + 7;
    } else {
      yield* paintAtom(markup.slice(cursor, tag.next), tag, context);
      cursor = tag.next;
    }
  }
}

function* textAtoms(markup: string, text: Tag, end: number, context: PaintContext) {
  const opening = markup.slice(markup.lastIndexOf("<text", text.next), text.next);
  for (let cursor = text.next; cursor < end;) {
    const span = parseOpeningTag(markup, cursor);
    const closing = markup.indexOf("</tspan>", span?.next ?? end);
    if (span === null || span.name !== "tspan" || closing < 0 || closing > end)
      throw new Error("Invalid canonical text run.");
    const run = markup.slice(cursor, closing + 8);
    const atom = `${opening}${run}</text>`;
    const themeClass = span.attributes.get("class");
    const bounds = nextAutoPaintBounds(context.runBounds, context.bounds);
    if (isAutoClass(themeClass) && bounds.maxX > bounds.minX && bounds.maxY > bounds.minY) {
      yield* autoPaintAtom(
        `${opening}${inheritAutoPaint(run, themeClass)}</text>`,
        text.attributes.get("transform") ?? "",
        context,
        bounds,
        themeClass,
      );
    } else yield translatedAtom(atom, context.parents);
    cursor = closing + 8;
  }
}

function* paintAtom(markup: string, tag: Tag, context: PaintContext): Iterable<string> {
  const themeClass = tag.attributes.get("class");
  const bounds = context.afterText
    ? nextAutoPaintBounds(context.followingPathBounds, context.bounds)
    : context.bounds;
  if (!isAutoClass(themeClass)) {
    yield translatedAtom(markup, context.parents);
    return;
  }
  yield* autoPaintAtom(
    inheritAutoPaint(markup, themeClass),
    tag.attributes.get("transform") ?? "",
    context,
    bounds,
    themeClass,
  );
}

function* autoPaintAtom(
  markup: string,
  transform: string,
  context: PaintContext,
  bounds: Bounds,
  themeClass: AutoClass,
) {
  const key = `${context.id}-${String(context.atom++)}`;
  const geometry = `inkbook-auto-geometry-${key}`;
  const parent = context.parents.filter(Boolean).join(" ");
  const inverse = inverseAutoPaintTransform(`${parent} ${transform}`.trim());
  yield `<g id="inkbook-auto-atom-${key}"><defs><g id="${geometry}"${parent === "" ? "" : ` transform="${parent}"`}>${markup}</g>`;
  let index = 0;
  for (const tile of autoPaintTiles(bounds)) {
    const attributes = autoTileAttributes(tile);
    const server = autoPaintServer(tile);
    context.servers?.add(server);
    yield `<pattern id="inkbook-auto-paint-${key}-${String(index)}" href="#inkbook-auto-server-paint-${server.key}" ${attributes} viewBox="${autoTileViewBox(tile)}"${inverse === "" ? "" : ` patternTransform="${inverse}"`}/>`;
    index += 1;
  }
  yield "</defs>";
  index = 0;
  for (const tile of autoPaintTiles(bounds)) {
    const paint = `url(#inkbook-auto-paint-${key}-${String(index)})`;
    const fill = themeClass === "inkbook-theme-stroke" ? "none" : paint;
    const stroke = themeClass === "inkbook-theme-fill" ? "none" : paint;
    yield `<svg ${autoTileAttributes(tile)} viewBox="${autoTileViewBox(tile)}" overflow="hidden" preserveAspectRatio="none"><use href="#${geometry}" fill="${fill}" stroke="${stroke}"/></svg>`;
    index += 1;
  }
  yield "</g>";
}

function translatedAtom(markup: string, transforms: readonly string[]): string {
  const transform = transforms.filter(Boolean).join(" ");
  return transform === "" ? markup : `<g transform="${transform}">${markup}</g>`;
}

function isAutoClass(value: string | undefined): value is AutoClass {
  return (
    value === "inkbook-theme-fill" ||
    value === "inkbook-theme-stroke" ||
    value === "inkbook-theme-stroke-fill"
  );
}

function inheritAutoPaint(markup: string, themeClass: string): string {
  let inherited = markup.replace(themeClass, themeClass.replace("theme", "auto"));
  if (themeClass !== "inkbook-theme-stroke")
    inherited = inherited.replace(/ fill="[^"]*"/u, ' fill="inherit"');
  if (themeClass !== "inkbook-theme-fill")
    inherited = inherited.replace(/ stroke="[^"]*"/u, ' stroke="inherit"');
  return inherited;
}
