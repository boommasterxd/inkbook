import { FILE_SCHEMA_LIMITS } from "../../domain/schema/public";
import { hasExactAttributes, parseOpeningTag, skipWhitespace } from "./svg-tag";
import { validateDashArray, validatePathDataSteps } from "./path-data-validator";
import {
  CANONICAL_THEME_STYLESHEET,
  DOCUMENT_PALETTE,
  DOCUMENT_THEME_FALLBACK,
  THEME_CLASSES,
  isSupportedThemeStylesheet,
  type ThemeClass,
} from "./svg-theme";
import { parseCanonicalSvgDecimal, parseCanonicalSvgOpacity } from "./svg-number";
import { parseSafeSvgRoot, type SafeSvgRoot, type SafeSvgVersionPolicy } from "./svg-envelope-root";
import { MAXIMUM_TOTAL_PATH_DATA_BYTES } from "./svg-output-limits";
import { decodeMetadataTextSteps, measureUtf8BytesSteps } from "./safe-svg-metadata";
const MAXIMUM_FILE_BYTES = 64 * 1024 * 1024;
const MAXIMUM_METADATA_BYTES = 60 * 1024 * 1024;
const MAXIMUM_PATHS = 60_004;
const MAXIMUM_TOTAL_COMMANDS = 8_000_000;
const DEFAULT_PATHS_PER_STEP = 128;
const MARKUP_CODE_UNITS_PER_STEP = 256 * 1024;
const RGBA = /^#[0-9A-F]{8}$/u;
const PATH_ATTRIBUTES = new Set([
  "class",
  "d",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "stroke-width",
]);

interface SafeSvgPrefix {
  readonly cursor: number;
  readonly metadataText: string;
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
  readonly groups: SafeSvgGroupRanges;
  readonly lockedHeight: number;
  readonly metadataBytes: number;
  readonly metadataText: string;
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
    requiresCanonicalRewrite: boolean;
  }
>;

interface SafeSvgMetadata {
  readonly metadataBytes: number;
  readonly metadataText: string;
}

function validatePaint(value: string | undefined): boolean {
  return value === undefined || value === "none" || RGBA.test(value);
}

function optionalMember(value: string | undefined, allowed: readonly string[]): boolean {
  return value === undefined || allowed.includes(value);
}

function validateOptionalDecimals(attributes: ReadonlyMap<string, string>): boolean {
  const opacityValid = ["fill-opacity", "stroke-opacity"].every((name) => {
    const value = attributes.get(name);
    return value === undefined || parseCanonicalSvgOpacity(value) !== null;
  });
  const width = attributes.get("stroke-width");
  return opacityValid && (width === undefined || parseCanonicalSvgDecimal(width, 256) !== null);
}

function* validatePathAttributesSteps(
  attributes: ReadonlyMap<string, string>,
  deadlineExceeded?: () => boolean,
): Generator<void, number | null> {
  if (
    attributes.size === 0 ||
    [...attributes.keys()].some((name) => !PATH_ATTRIBUTES.has(name)) ||
    !validatePaint(attributes.get("fill")) ||
    !validatePaint(attributes.get("stroke"))
  ) {
    return null;
  }
  const pathData = attributes.get("d");
  const pathResult =
    pathData === undefined
      ? null
      : yield* validatePathDataSteps(
          pathData,
          deadlineExceeded === undefined ? {} : { deadlineExceeded },
        );
  if (pathResult === null) {
    return null;
  }
  const className = attributes.get("class");
  if (className !== undefined && !THEME_CLASSES.some((entry) => entry === className)) {
    return null;
  }
  if (className !== undefined && !validateThemeFallback(attributes, className as ThemeClass)) {
    return null;
  }
  if (
    !optionalMember(attributes.get("fill-rule"), ["nonzero", "evenodd"]) ||
    !optionalMember(attributes.get("stroke-linecap"), ["butt", "round", "square"]) ||
    !optionalMember(attributes.get("stroke-linejoin"), ["miter", "round", "bevel"]) ||
    !validateOptionalDecimals(attributes)
  ) {
    return null;
  }
  const dash = attributes.get("stroke-dasharray");
  return dash !== undefined && !validateDashArray(dash) ? null : pathResult.commands;
}

function validateThemeFallback(
  attributes: ReadonlyMap<string, string>,
  className: ThemeClass,
): boolean {
  const text = DOCUMENT_PALETTE.light.text;
  switch (className) {
    case "inkbook-theme-page":
      return attributes.get("fill") === DOCUMENT_PALETTE.light.page;
    case "inkbook-theme-guide":
      return attributes.get("stroke") === DOCUMENT_THEME_FALLBACK.guide;
    case "inkbook-theme-stroke":
      return attributes.get("stroke") === text;
    case "inkbook-theme-fill":
      return attributes.get("fill") === text;
    case "inkbook-theme-stroke-fill":
      return attributes.get("stroke") === text && attributes.get("fill") === text;
  }
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

interface SvgTotals {
  commands: number;
  groups: number;
  pathBytes: number;
  paths: number;
}

function validPressureGroup(
  tag: NonNullable<ReturnType<typeof parseOpeningTag>>,
  id: string,
  pressurePaths: number | null,
  totals: SvgTotals,
): boolean {
  if (
    id === "inkbook-background" ||
    pressurePaths !== null ||
    tag.selfClosing ||
    tag.attributes.size !== 1 ||
    parseCanonicalSvgOpacity(tag.attributes.get("opacity")) === null
  )
    return false;
  totals.groups += 1;
  return totals.groups <= FILE_SCHEMA_LIMITS.elements;
}

function accountPath(totals: SvgTotals, commands: number, pathData: string): boolean {
  totals.paths += 1;
  totals.commands += commands;
  totals.pathBytes += pathData.length;
  return (
    totals.paths <= MAXIMUM_PATHS &&
    totals.commands <= MAXIMUM_TOTAL_COMMANDS &&
    totals.pathBytes <= MAXIMUM_TOTAL_PATH_DATA_BYTES
  );
}

function isBandGroup(tag: ReturnType<typeof parseOpeningTag>, id: string): boolean {
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
    if (pressurePaths !== null && input.startsWith("</g>", cursor)) {
      if (pressurePaths === 0) return null;
      pressurePaths = null;
      cursor = skipWhitespace(input, cursor + 4);
      continue;
    }
    const path = parseOpeningTag(input, cursor);
    if (path?.name === "g") {
      if (!validPressureGroup(path, id, pressurePaths, totals)) return null;
      pressurePaths = 0;
      cursor = skipWhitespace(input, path.next);
      continue;
    }
    if (path === null || path.name !== "path" || !path.selfClosing) {
      return null;
    }
    const commands = yield* validatePathAttributesSteps(path.attributes, deadlineExceeded);
    const pathData = path.attributes.get("d")!;
    if (commands === null) {
      return null;
    }
    if (pressurePaths !== null && ++pressurePaths > 1) return null;
    if (!accountPath(totals, commands, pathData)) return null;
    cursor = skipWhitespace(input, path.next);
    pathsSinceStep += 1;
    if (pathsSinceStep === pathsPerStep) {
      pathsSinceStep = 0;
      yield;
    }
  }
  if (pathsSinceStep > 0) yield;
  return { next: cursor + 4, range: { end: cursor, start: contentStart } };
}

export function validateSafeSvg(svg: string): SafeSvgValidation | null {
  return completeValidation(validateSafeSvgSteps(svg));
}

export function validateEditableSafeSvg(svg: string): SafeSvgValidation | null {
  return completeValidation(validateSafeSvgSteps(svg, { versionPolicy: "editable" }));
}

/** Validates the bounded root, stylesheet, and opening metadata tag without retaining static paths. */
export function validateEditableSafeSvgPrelude(prefix: string): SafeSvgPrelude | null {
  const synthetic =
    `${prefix}</metadata>` +
    '<g id="inkbook-background"></g>' +
    '<g id="inkbook-highlights"></g>' +
    '<g id="inkbook-content"></g></svg>';
  const safe = validateEditableSafeSvg(synthetic);
  return safe === null
    ? null
    : {
        lockedHeight: safe.lockedHeight,
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
  const metadataText = yield* decodeMetadataTextSteps(input);
  if (metadataText === null) return null;
  const metadataBytes = yield* measureUtf8BytesSteps(metadataText);
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
  const prefix = parseSafeSvgPrefix(svg, versionPolicy);
  if (prefix === null) {
    return null;
  }
  const metadata = yield* validateSafeSvgMetadataSteps(prefix.metadataText);
  if (metadata === null) return null;
  let cursor = prefix.cursor;
  const totals = { commands: 0, groups: 0, pathBytes: 0, paths: 0 };
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
    groups,
    lockedHeight: prefix.root.height,
    metadataBytes: metadata.metadataBytes,
    metadataText: metadata.metadataText,
    pathCommands: totals.commands,
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

function parseSafeSvgPrefix(
  svg: string,
  versionPolicy: SafeSvgVersionPolicy,
): SafeSvgPrefix | null {
  let cursor = skipWhitespace(svg, 0);
  const rootTag = parseOpeningTag(svg, cursor);
  const root = rootTag === null ? null : parseSafeSvgRoot(rootTag, versionPolicy);
  if (rootTag === null || root === null) return null;
  cursor = skipWhitespace(svg, rootTag.next);
  const style = expectTextElement(svg, cursor, "style", { id: "inkbook-theme" });
  if (style === null || !isSupportedThemeStylesheet(style.text)) return null;
  cursor = skipWhitespace(svg, style.next);
  const metadata = expectTextElement(svg, cursor, "metadata", {
    "data-encoding": "json",
    id: "inkbook-snapshot",
  });
  return metadata === null
    ? null
    : {
        cursor: skipWhitespace(svg, metadata.next),
        metadataText: metadata.text,
        requiresCanonicalRewrite: style.text !== CANONICAL_THEME_STYLESHEET,
        root,
      };
}

function completeValidation(
  steps: Generator<void, SafeSvgValidation | null>,
): SafeSvgValidation | null {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}
