import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import {
  isBandGroup,
  validPressureGroup,
  validatePathAttributesSteps,
  type SvgTotals,
} from "../documents/safe-svg-validator";
import { parseOpeningTag, skipWhitespace } from "../documents/svg-tag";
import { parseSafeSvgRoot } from "../documents/svg-envelope-root";
import { consumeSerializationSteps } from "../serialization/output/serialization-model-preparation";
import { StaticPathBounds } from "./static-path-bounds";
import { findStaticSvgTokenSteps } from "./static-svg-scanner";

export interface StaticExportFragment {
  readonly minY: number;
  readonly maxY: number;
  readonly background: boolean;
}

interface StaticExportFragmentOptions {
  readonly workScheduler: WorkScheduler;
  readonly signal?: AbortSignal;
  readonly visitor?: StaticExportTagVisitor;
}

export type StaticExportTag = NonNullable<ReturnType<typeof parseOpeningTag>>;
export interface StaticExportTagVisitor {
  open(tag: StaticExportTag): void;
  close(): void;
}

type SvgTag = StaticExportTag;
interface FragmentParseContext {
  readonly band: string;
  readonly totals: SvgTotals;
  readonly exhausted: () => boolean;
  readonly visitor?: StaticExportTagVisitor;
}

interface ParsedFragment {
  readonly bounds: { minY: number; maxY: number };
  readonly next: number;
}

const BANDS = ["inkbook-background", "inkbook-highlights", "inkbook-content"];

/** Input must already have complete safe-envelope validation; this does not validate metadata. */
export async function prepareStaticExportFragments(
  safeSvg: string,
  options: StaticExportFragmentOptions,
): Promise<readonly StaticExportFragment[] | undefined> {
  const context = {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    checkpoint: () => options.workScheduler.checkpoint(options.signal, "background"),
  };
  options.signal?.throwIfAborted();
  const pending = context.checkpoint();
  if (pending !== undefined) await pending;
  return consumeSerializationSteps(
    prepareFragmentSteps(safeSvg, () => options.workScheduler.shouldYield(), options.visitor),
    context,
  );
}

function* prepareFragmentSteps(
  svg: string,
  exhausted: () => boolean,
  visitor?: StaticExportTagVisitor,
): Generator<void, readonly StaticExportFragment[] | undefined> {
  const fragments: StaticExportFragment[] = [];
  const prefix = yield* skipPrefixSteps(svg, exhausted, visitor);
  if (prefix === undefined) return undefined;
  let cursor = prefix;
  const totals = { commands: 0, groups: 0, pathBytes: 0, paths: 0 };
  for (const band of BANDS) {
    const opening = parseOpeningTag(svg, cursor);
    if (!isBandGroup(opening, band)) return undefined;
    visitor?.open(opening!);
    cursor = skipWhitespace(svg, opening!.next);
    const context = { band, totals, exhausted, ...(visitor === undefined ? {} : { visitor }) };
    while (!svg.startsWith("</g>", cursor)) {
      const fragment = yield* parseFragmentSteps(svg, cursor, context);
      if (fragment === undefined) return undefined;
      fragments.push({ ...fragment.bounds, background: band === BANDS[0] });
      cursor = fragment.next;
      if (exhausted()) yield;
    }
    visitor?.close();
    cursor = skipWhitespace(svg, cursor + 4);
  }
  if (!svg.startsWith("</svg>", cursor) || skipWhitespace(svg, cursor + 6) !== svg.length)
    return undefined;
  visitor?.close();
  return fragments;
}

function* parseFragmentSteps(
  svg: string,
  cursor: number,
  context: FragmentParseContext,
): Generator<void, ParsedFragment | undefined> {
  const exhausted = context.exhausted;
  const start = yield* findStaticSvgTokenSteps(svg, "<", cursor, exhausted);
  if (start !== cursor) return undefined;
  const end = yield* findStaticSvgTokenSteps(svg, ">", start, exhausted);
  if (end < 0) return undefined;
  let tag = parseOpeningTag(svg.slice(start, end + 1), 0);
  if (tag === null) return undefined;
  cursor = skipWhitespace(svg, end + 1);
  const grouped = tag.name === "g";
  let translationY = 0;
  if (grouped) {
    if (!validPressureGroup(tag, context.band, null, context.totals)) return undefined;
    context.visitor?.open(tag);
    translationY = parseTranslationY(tag);
    const pathEnd = yield* findStaticSvgTokenSteps(svg, ">", cursor, exhausted);
    if (pathEnd < 0) return undefined;
    tag = parseOpeningTag(svg.slice(cursor, pathEnd + 1), 0);
    cursor = skipWhitespace(svg, pathEnd + 1);
  }
  if (tag === null || tag.name !== "path" || !tag.selfClosing) return undefined;
  const bounds = yield* preparePathBoundsSteps(tag, translationY, exhausted);
  if (bounds === undefined) return undefined;
  context.visitor?.open(tag);
  if (grouped) {
    if (!svg.startsWith("</g>", cursor)) return undefined;
    context.visitor?.close();
    cursor = skipWhitespace(svg, cursor + 4);
  }
  return { bounds, next: cursor };
}

function* skipPrefixSteps(
  svg: string,
  exhausted: () => boolean,
  visitor?: StaticExportTagVisitor,
): Generator<void, number | undefined> {
  let cursor = skipWhitespace(svg, 0);
  const root = parseOpeningTag(svg, cursor);
  if (root === null || parseSafeSvgRoot(root, "editable") === null) return undefined;
  visitor?.open(root);
  cursor = skipWhitespace(svg, root.next);
  for (const name of ["style", "metadata"]) {
    const tag = parseOpeningTag(svg, cursor);
    if (tag?.name !== name || tag.selfClosing) return undefined;
    const close = `</${name}>`;
    const end = yield* findStaticSvgTokenSteps(svg, close, tag.next, exhausted);
    if (end < 0) return undefined;
    cursor = skipWhitespace(svg, end + close.length);
  }
  return cursor;
}

function parseTranslationY(tag: SvgTag): number {
  const transform = tag.attributes.get("transform");
  return transform === undefined ? 0 : Number(transform.slice(10, -1).split(" ")[1]);
}

function* preparePathBoundsSteps(
  tag: SvgTag,
  translationY: number,
  exhausted: () => boolean,
): Generator<void, { minY: number; maxY: number } | undefined> {
  const bounds = new StaticPathBounds();
  const result = yield* validatePathAttributesSteps(
    tag.attributes,
    exhausted,
    (command, values, startY, endY, startX) =>
      bounds.observe(command, values, startY, endY, startX),
  );
  if (result === null) return undefined;
  if (tag.attributes.get("class") === "inkbook-theme-guide") {
    // Export gives guides non-scaling strokes; their SVG-unit extent depends on print scale.
    return { minY: -Infinity, maxY: Infinity };
  }
  const stroke = tag.attributes.get("stroke");
  const width =
    stroke === undefined || stroke === "none"
      ? 0
      : Number(tag.attributes.get("stroke-width") ?? "1");
  return bounds.painted(translationY, width);
}
