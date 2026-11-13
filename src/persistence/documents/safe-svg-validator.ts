import { FILE_SCHEMA_LIMITS } from "../../domain/schema/public";
import { hasExactAttributes, parseOpeningTag, skipWhitespace } from "./svg-tag";
import { validatePathAttributesSteps } from "./safe-svg-paths";
export { validatePathAttributesSteps } from "./safe-svg-paths";
import { CANONICAL_THEME_STYLESHEET, isSupportedThemeStylesheet } from "./svg-theme";
import { parseCanonicalSvgOpacity } from "./svg-number";
import { parseSafeSvgRoot, type SafeSvgRoot, type SafeSvgVersionPolicy } from "./svg-envelope-root";
import { MAXIMUM_TOTAL_PATH_DATA_BYTES } from "./svg-output-limits";
import { decodeMetadataTextSteps, measureUtf8BytesSteps } from "./safe-svg-metadata";
import { validateFontStylesheetSteps, type SafeSvgFontFace } from "./safe-svg-fonts";
import { validateTextElementSteps } from "./safe-svg-text";
import {
  COMPACT_METADATA_ENCODING,
  type SnapshotMetadataEncoding,
} from "../serialization/metadata/stroke-sample-codec";
const MAXIMUM_FILE_BYTES = 64 * 1024 * 1024;
const MAXIMUM_METADATA_BYTES = 60 * 1024 * 1024;
const MAXIMUM_PATHS = 60_004;
const MAXIMUM_TOTAL_COMMANDS = 8_000_000;
const DEFAULT_PATHS_PER_STEP = 128;
const MARKUP_CODE_UNITS_PER_STEP = 256 * 1024;
interface SafeSvgPrefix {
  readonly fontFaces?: readonly SafeSvgFontFace[];
  readonly fontStylesheet?: string;
  readonly cursor: number;
  readonly metadataText: string;
  readonly metadataEncoding: SnapshotMetadataEncoding;
  readonly requiresCanonicalRewrite: boolean;
  readonly root: SafeSvgRoot;
}

export type SafeSvgGroupRange = Readonly<{ end: number; start: number }>;
type SafeSvgGroupRanges = Readonly<
  Record<"background" | "content" | "highlights", SafeSvgGroupRange>
>;
export interface SafeSvgValidationStepOptions {
  readonly deadlineExceeded?: () => boolean;
  readonly pathsPerStep?: number;
  readonly totalInputBytes?: number;
  readonly versionPolicy?: SafeSvgVersionPolicy;
}

export interface SafeSvgValidation {
  readonly unadjustedTextRuns: number;
  readonly fontFaces?: readonly SafeSvgFontFace[];
  readonly fontStylesheet?: string;
  readonly groups: SafeSvgGroupRanges;
  readonly lockedHeight: number;
  readonly metadataBytes: number;
  readonly metadataText: string;
  readonly metadataEncoding: SnapshotMetadataEncoding;
  readonly pathCommands: number;
  readonly paths: number;
  readonly revision: number;
  readonly requiresCanonicalRewrite: boolean;
  readonly snapshotHash: string | null;
  readonly version: number;
}

export type SafeSvgPrelude = Readonly<
  Pick<SafeSvgRoot, "revision" | "snapshotHash" | "version"> & {
    lockedHeight: number;
    fontStylesheet?: string;
    fontFaces?: readonly SafeSvgFontFace[];
    metadataEncoding: SnapshotMetadataEncoding;
    requiresCanonicalRewrite: boolean;
  }
>;

interface SafeSvgMetadata {
  readonly metadataBytes: number;
  readonly metadataText: string;
}

function expectTextElement(
  input: string,
  start: number,
  name: string,
  attributes: Readonly<Record<string, string>>,
): { next: number; text: string } | null {
  const tag = parseOpeningTag(input, start);
  if (
    tag === null ||
    tag.name !== name ||
    tag.selfClosing ||
    !hasExactAttributes(tag.attributes, attributes)
  ) {
    return null;
  }
  const closing = `</${name}>`;
  const end = input.indexOf(closing, tag.next);
  return end < 0 ? null : { next: end + closing.length, text: input.slice(tag.next, end) };
}

export interface SvgTotals {
  commands: number;
  groups: number;
  pathBytes: number;
  paths: number;
  textElements?: number;
  unadjustedTextRuns?: number;
}

export function validPressureGroup(
  tag: NonNullable<ReturnType<typeof parseOpeningTag>>,
  id: string,
  pressurePaths: number | null,
  totals: SvgTotals,
): boolean {
  if (
    id === "inkbook-background" ||
    pressurePaths !== null ||
    tag.selfClosing ||
    !validStrokeGroupAttributes(tag.attributes)
  )
    return false;
  totals.groups += 1;
  return totals.groups <= FILE_SCHEMA_LIMITS.elements;
}

function validStrokeGroupAttributes(attributes: ReadonlyMap<string, string>): boolean {
  if (attributes.size < 1 || attributes.size > 2) return false;
  if ([...attributes.keys()].some((name) => name !== "opacity" && name !== "transform"))
    return false;
  const opacity = attributes.get("opacity");
  if (opacity !== undefined && parseCanonicalSvgOpacity(opacity) === null) return false;
  const transform = attributes.get("transform");
  if (transform === undefined) return opacity !== undefined;
  const match =
    /^translate\((-?(?:0|[1-9]\d*)(?:\.\d{1,3})?) (-?(?:0|[1-9]\d*)(?:\.\d{1,3})?)\)$/u.exec(
      transform,
    );
  return (
    match !== null &&
    match.slice(1).every((value) => {
      const number = Number(value);
      return Math.abs(number) <= 1_000_000 && number.toString() === value;
    })
  );
}

export function accountPath(totals: SvgTotals, commands: number, pathData: string): boolean {
  totals.paths += 1;
  totals.commands += commands;
  totals.pathBytes += pathData.length;
  return (
    totals.paths <= MAXIMUM_PATHS &&
    totals.commands <= MAXIMUM_TOTAL_COMMANDS &&
    totals.pathBytes <= MAXIMUM_TOTAL_PATH_DATA_BYTES
  );
}

export function isBandGroup(tag: ReturnType<typeof parseOpeningTag>, id: string): boolean {
  return (
    tag !== null &&
    tag.name === "g" &&
    !tag.selfClosing &&
    hasExactAttributes(tag.attributes, { id })
  );
}

function* parsePathGroupSteps(
  input: string,
  start: number,
  id: string,
  totals: SvgTotals,
  pathsPerStep: number,
  deadlineExceeded?: () => boolean,
): Generator<void, { readonly next: number; readonly range: SafeSvgGroupRange } | null> {
  const group = parseOpeningTag(input, start);
  if (!isBandGroup(group, id)) return null;
  const contentStart = group!.next;
  let cursor = skipWhitespace(input, contentStart);
  let pathsSinceStep = 0;
  let pressurePaths: number | null = null;
  while (pressurePaths !== null || !input.startsWith("</g>", cursor)) {
    if (input.startsWith("</g>", cursor)) {
      if (pressurePaths === 0) return null;
      pressurePaths = null;
      cursor = skipWhitespace(input, cursor + 4);
      continue;
    }
    const path = parseOpeningTag(input, cursor);
    if (path?.name === "text") {
      const next = yield* parseBandTextSteps(input, cursor, { id, pressurePaths, totals });
      if (next === null) return null;
      cursor = skipWhitespace(input, next);
      continue;
    }
    if (path?.name === "g") {
      if (!validPressureGroup(path, id, pressurePaths, totals)) return null;
      pressurePaths = 0;
      cursor = skipWhitespace(input, path.next);
      continue;
    }
    const next = yield* parseSinglePathSteps(path, totals, deadlineExceeded);
    if (next === null) return null;
    if (pressurePaths !== null && ++pressurePaths > 1) return null;
    cursor = skipWhitespace(input, next);
    pathsSinceStep += 1;
    if (pathsSinceStep === pathsPerStep) {
      pathsSinceStep = 0;
      yield;
    }
  }
  if (pathsSinceStep > 0) yield;
  return { next: cursor + 4, range: { end: cursor, start: contentStart } };
}

function* parseSinglePathSteps(
  path: ReturnType<typeof parseOpeningTag>,
  totals: SvgTotals,
  deadlineExceeded?: () => boolean,
): Generator<void, number | null> {
  if (path === null || path.name !== "path" || !path.selfClosing) return null;
  const commands = yield* validatePathAttributesSteps(
    path.attributes,
    deadlineExceeded,
    undefined,
    totals.textElements === undefined ? 1 : 2,
  );
  return commands !== null && accountPath(totals, commands, path.attributes.get("d")!)
    ? path.next
    : null;
}

function* parseBandTextSteps(
  input: string,
  cursor: number,
  context: { id: string; pressurePaths: number | null; totals: SvgTotals },
): Generator<void, number | null> {
  const { id, pressurePaths, totals } = context;
  if (id !== "inkbook-content" || pressurePaths !== null || totals.textElements === undefined)
    return null;
  const next = yield* validateTextElementSteps(input, cursor, {
    open: () => undefined,
    close: () => undefined,
    unadjustedText: () => {
      totals.unadjustedTextRuns = (totals.unadjustedTextRuns ?? 0) + 1;
    },
  });
  totals.textElements += 1;
  return totals.textElements > FILE_SCHEMA_LIMITS.elements ? null : next;
}

export function validateSafeSvg(svg: string): SafeSvgValidation | null {
  return completeValidation(validateSafeSvgSteps(svg));
}

/** Validates the bounded root, stylesheet, and opening metadata tag without retaining static paths. */
export function* validateEditableSafeSvgPreludeSteps(
  prefix: string,
): Generator<void, SafeSvgPrelude | null> {
  const synthetic =
    `${prefix}</metadata>` +
    '<g id="inkbook-background"></g>' +
    '<g id="inkbook-highlights"></g>' +
    '<g id="inkbook-content"></g></svg>';
  const safe = yield* validateSafeSvgSteps(synthetic, { versionPolicy: "editable" });
  return safe === null
    ? null
    : {
        ...(safe.fontStylesheet === undefined ? {} : { fontStylesheet: safe.fontStylesheet }),
        ...(safe.fontFaces === undefined ? {} : { fontFaces: safe.fontFaces }),
        lockedHeight: safe.lockedHeight,
        metadataEncoding: safe.metadataEncoding,
        requiresCanonicalRewrite: safe.requiresCanonicalRewrite,
        revision: safe.revision,
        snapshotHash: safe.snapshotHash,
        version: safe.version,
      };
}

/** Decodes the sole metadata text with the same byte and entity limits as complete validation. */
function* validateSafeSvgMetadataSteps(input: string): Generator<void, SafeSvgMetadata | null> {
  const rawMetadataBytes = yield* measureUtf8BytesSteps(input);
  if (rawMetadataBytes > MAXIMUM_METADATA_BYTES) return null;
  const decoded = yield* decodeMetadataTextSteps(input);
  if (decoded === null) return null;
  const metadataText = decoded.text;
  const metadataBytes = rawMetadataBytes - decoded.entityByteSavings;
  return metadataBytes > MAXIMUM_METADATA_BYTES ? null : { metadataBytes, metadataText };
}

export function* validateSafeSvgSteps(
  svg: string,
  options: SafeSvgValidationStepOptions = {},
): Generator<void, SafeSvgValidation | null> {
  const inputBytes = options.totalInputBytes ?? new TextEncoder().encode(svg).byteLength;
  const pathsPerStep = options.pathsPerStep ?? DEFAULT_PATHS_PER_STEP;
  if (isInvalidStepInput(inputBytes, pathsPerStep)) {
    return null;
  }
  if (yield* hasUnsupportedMarkupSteps(svg)) return null;
  const versionPolicy = options.versionPolicy ?? "current";
  const prefix = yield* parseSafeSvgPrefixSteps(svg, versionPolicy);
  if (prefix === null) {
    return null;
  }
  const metadata = yield* validateSafeSvgMetadataSteps(prefix.metadataText);
  if (metadata === null) return null;
  let cursor = prefix.cursor;
  const totals: SvgTotals = {
    commands: 0,
    groups: 0,
    pathBytes: 0,
    paths: 0,
    ...(prefix.root.version >= 2 ? { textElements: 0 } : {}),
  };
  const groups = {} as Record<keyof SafeSvgGroupRanges, SafeSvgGroupRange>;
  for (const group of ["inkbook-background", "inkbook-highlights", "inkbook-content"]) {
    const parsedGroup = yield* parsePathGroupSteps(
      svg,
      cursor,
      group,
      totals,
      pathsPerStep,
      options.deadlineExceeded,
    );
    if (parsedGroup === null) {
      return null;
    }
    const key = group.replace("inkbook-", "") as keyof SafeSvgGroupRanges;
    groups[key] = parsedGroup.range;
    cursor = skipWhitespace(svg, parsedGroup.next);
  }
  if (!svg.startsWith("</svg>", cursor) || skipWhitespace(svg, cursor + 6) !== svg.length) {
    return null;
  }
  return {
    ...(prefix.fontStylesheet === undefined ? {} : { fontStylesheet: prefix.fontStylesheet }),
    ...(prefix.fontFaces === undefined ? {} : { fontFaces: prefix.fontFaces }),
    groups,
    lockedHeight: prefix.root.height,
    metadataBytes: metadata.metadataBytes,
    metadataText: metadata.metadataText,
    metadataEncoding: prefix.metadataEncoding,
    pathCommands: totals.commands,
    unadjustedTextRuns: totals.unadjustedTextRuns ?? 0,
    paths: totals.paths,
    revision: prefix.root.revision,
    requiresCanonicalRewrite: prefix.requiresCanonicalRewrite,
    snapshotHash: prefix.root.snapshotHash,
    version: prefix.root.version,
  };
}

function isInvalidStepInput(inputBytes: number, pathsPerStep: number): boolean {
  return (
    !Number.isSafeInteger(inputBytes) ||
    inputBytes < 0 ||
    !Number.isSafeInteger(pathsPerStep) ||
    pathsPerStep < 1 ||
    inputBytes > MAXIMUM_FILE_BYTES
  );
}

function* hasUnsupportedMarkupSteps(svg: string): Generator<void, boolean> {
  for (let start = 0; start < svg.length; start += MARKUP_CODE_UNITS_PER_STEP) {
    const end = Math.min(start + MARKUP_CODE_UNITS_PER_STEP, svg.length);
    // One overlapping code unit keeps declarations split across slices rejectable.
    if (/<!|<\?/u.test(svg.slice(start, end + 1))) return true;
    if (end < svg.length) yield;
  }
  return false;
}

function* parseSafeSvgPrefixSteps(
  svg: string,
  versionPolicy: SafeSvgVersionPolicy,
): Generator<void, SafeSvgPrefix | null> {
  let cursor = skipWhitespace(svg, 0);
  const rootTag = parseOpeningTag(svg, cursor);
  const root = rootTag === null ? null : parseSafeSvgRoot(rootTag, versionPolicy);
  if (rootTag === null || root === null) return null;
  cursor = skipWhitespace(svg, rootTag.next);
  const style = expectTextElement(svg, cursor, "style", { id: "inkbook-theme" });
  if (style === null || !isSupportedThemeStylesheet(style.text)) return null;
  cursor = skipWhitespace(svg, style.next);
  let fontStylesheet: string | undefined;
  let fontFaces: SafeSvgFontFace[] | undefined;
  if (svg.startsWith('<style id="inkbook-fonts">', cursor)) {
    const fonts = expectTextElement(svg, cursor, "style", { id: "inkbook-fonts" });
    fontFaces = [];
    const parsedFaces = fontFaces;
    if (
      root.version < 2 ||
      fonts === null ||
      !(yield* validateFontStylesheetSteps(fonts.text, (face) => parsedFaces.push(face)))
    )
      return null;
    fontStylesheet = fonts.text;
    cursor = skipWhitespace(svg, fonts.next);
  }
  const metadataTag = parseOpeningTag(svg, cursor);
  const metadataEncoding = metadataTag?.attributes.get("data-encoding");
  if (metadataEncoding !== "json" && metadataEncoding !== COMPACT_METADATA_ENCODING) return null;
  const metadata = expectTextElement(svg, cursor, "metadata", {
    "data-encoding": metadataEncoding,
    id: "inkbook-snapshot",
  });
  return metadata === null
    ? null
    : {
        ...(fontStylesheet === undefined ? {} : { fontStylesheet }),
        ...(fontFaces === undefined ? {} : { fontFaces }),
        cursor: skipWhitespace(svg, metadata.next),
        metadataText: metadata.text,
        metadataEncoding,
        requiresCanonicalRewrite: style.text !== CANONICAL_THEME_STYLESHEET,
        root,
      };
}

function completeValidation<T>(steps: Generator<void, T>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}
