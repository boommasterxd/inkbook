import { validateDashArray, validatePathDataSteps } from "./path-data-validator";
import {
  DOCUMENT_PALETTE,
  DOCUMENT_THEME_FALLBACK,
  THEME_CLASSES,
  isSupportedThemeStylesheet,
  type ThemeClass,
} from "./svg-theme";
import { parseCanonicalSvgDecimal, parseCanonicalSvgOpacity } from "./svg-number";
import { parseSafeSvgRoot, type SafeSvgRoot, type SafeSvgVersionPolicy } from "./svg-envelope-root";
import { MAXIMUM_TOTAL_PATH_DATA_BYTES } from "./svg-output-limits";
const MAXIMUM_FILE_BYTES = 64 * 1024 * 1024;
const MAXIMUM_METADATA_BYTES = 60 * 1024 * 1024;
const MAXIMUM_PATHS = 60_004;
const MAXIMUM_TOTAL_COMMANDS = 8_000_000;
const DEFAULT_PATHS_PER_STEP = 128;
const METADATA_CODE_UNITS_PER_STEP = 256 * 1024;
const METADATA_DECODE_CODE_UNITS_PER_STEP = 16 * 1024;
const RGBA = /^#[0-9A-F]{8}$/u;
const ATTRIBUTE_NAME = /^[A-Za-z][A-Za-z0-9-]*$/u;
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
interface ParsedTag {
  readonly attributes: ReadonlyMap<string, string>;
  readonly name: string;
  readonly next: number;
  readonly selfClosing: boolean;
}

interface SafeSvgPrefix {
  readonly cursor: number;
  readonly metadataText: string;
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
  readonly snapshotHash: string | null;
  readonly version: number;
}

export type SafeSvgPrelude = Readonly<
  Pick<SafeSvgRoot, "revision" | "snapshotHash" | "version"> & { lockedHeight: number }
>;

interface SafeSvgMetadata {
  readonly metadataBytes: number;
  readonly metadataText: string;
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\r" || character === "\n";
}

function skipWhitespace(input: string, start: number): number {
  let cursor = start;
  while (cursor < input.length && isWhitespace(input[cursor]!)) {
    cursor += 1;
  }
  return cursor;
}

function parseQuotedValue(input: string, start: number): { next: number; value: string } | null {
  if (input[start] !== '"') {
    return null;
  }
  const end = input.indexOf('"', start + 1);
  if (end < 0) {
    return null;
  }
  const value = input.slice(start + 1, end);
  return value.includes("<") || value.includes("&") ? null : { next: end + 1, value };
}

function parseOpeningTag(input: string, start: number): ParsedTag | null {
  if (input[start] !== "<" || input[start + 1] === "/") {
    return null;
  }
  let cursor = start + 1;
  const nameStart = cursor;
  while (cursor < input.length && /[A-Za-z0-9-]/u.test(input[cursor]!)) {
    cursor += 1;
  }
  const name = input.slice(nameStart, cursor);
  if (!ATTRIBUTE_NAME.test(name)) {
    return null;
  }
  const attributes = new Map<string, string>();
  while (cursor < input.length) {
    const beforeWhitespace = cursor;
    cursor = skipWhitespace(input, cursor);
    if (input.startsWith("/>", cursor)) {
      return { attributes, name, next: cursor + 2, selfClosing: true };
    }
    if (input[cursor] === ">") {
      return { attributes, name, next: cursor + 1, selfClosing: false };
    }
    if (cursor === beforeWhitespace) {
      return null;
    }
    const attributeStart = cursor;
    while (cursor < input.length && /[A-Za-z0-9-]/u.test(input[cursor]!)) {
      cursor += 1;
    }
    const attribute = input.slice(attributeStart, cursor);
    if (!ATTRIBUTE_NAME.test(attribute) || attributes.has(attribute)) {
      return null;
    }
    cursor = skipWhitespace(input, cursor);
    if (input[cursor] !== "=") {
      return null;
    }
    cursor = skipWhitespace(input, cursor + 1);
    const quoted = parseQuotedValue(input, cursor);
    if (quoted === null) {
      return null;
    }
    attributes.set(attribute, quoted.value);
    cursor = quoted.next;
  }
  return null;
}

function hasExactAttributes(
  attributes: ReadonlyMap<string, string>,
  expected: Readonly<Record<string, string>>,
): boolean {
  return (
    attributes.size === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => attributes.get(key) === value)
  );
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

function* parsePathGroupSteps(
  input: string,
  start: number,
  id: string,
  totals: { commands: number; pathBytes: number; paths: number },
  pathsPerStep: number,
  deadlineExceeded?: () => boolean,
): Generator<void, { readonly next: number; readonly range: SafeSvgGroupRange } | null> {
  const group = parseOpeningTag(input, start);
  if (
    group === null ||
    group.name !== "g" ||
    group.selfClosing ||
    !hasExactAttributes(group.attributes, { id })
  ) {
    return null;
  }
  const contentStart = group.next;
  let cursor = skipWhitespace(input, contentStart);
  let pathsSinceStep = 0;
  while (!input.startsWith("</g>", cursor)) {
    const path = parseOpeningTag(input, cursor);
    if (path === null || path.name !== "path" || !path.selfClosing) {
      return null;
    }
    const commands = yield* validatePathAttributesSteps(path.attributes, deadlineExceeded);
    const pathData = path.attributes.get("d")!;
    if (commands === null) {
      return null;
    }
    totals.paths += 1;
    totals.commands += commands;
    totals.pathBytes += pathData.length;
    if (
      totals.paths > MAXIMUM_PATHS ||
      totals.commands > MAXIMUM_TOTAL_COMMANDS ||
      totals.pathBytes > MAXIMUM_TOTAL_PATH_DATA_BYTES
    ) {
      return null;
    }
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

export function validateNewerVersionSafeSvg(svg: string): SafeSvgValidation | null {
  return completeValidation(validateSafeSvgSteps(svg, { versionPolicy: "newer" }));
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
  if (isInvalidStepInput(svg, inputBytes, pathsPerStep)) {
    return null;
  }
  const versionPolicy = options.versionPolicy ?? "current";
  const prefix = parseSafeSvgPrefix(svg, versionPolicy);
  if (prefix === null) {
    return null;
  }
  const metadata = yield* validateSafeSvgMetadataSteps(prefix.metadataText);
  if (metadata === null) return null;
  let cursor = prefix.cursor;
  const totals = { commands: 0, pathBytes: 0, paths: 0 };
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
    snapshotHash: prefix.root.snapshotHash,
    version: prefix.root.version,
  };
}

function isInvalidStepInput(svg: string, inputBytes: number, pathsPerStep: number): boolean {
  return (
    !Number.isSafeInteger(inputBytes) ||
    inputBytes < 0 ||
    !Number.isSafeInteger(pathsPerStep) ||
    pathsPerStep < 1 ||
    inputBytes > MAXIMUM_FILE_BYTES ||
    /<!|<\?/u.test(svg)
  );
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
    : { cursor: skipWhitespace(svg, metadata.next), metadataText: metadata.text, root };
}

function completeValidation(
  steps: Generator<void, SafeSvgValidation | null>,
): SafeSvgValidation | null {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

function* measureUtf8BytesSteps(input: string): Generator<void, number> {
  const encoder = new TextEncoder();
  let bytes = 0;
  let start = 0;
  while (start < input.length) {
    let end = Math.min(start + METADATA_CODE_UNITS_PER_STEP, input.length);
    const trailing = input.charCodeAt(end - 1);
    if (end < input.length && trailing >= 0xd800 && trailing <= 0xdbff) end -= 1;
    bytes += encoder.encode(input.slice(start, end)).byteLength;
    start = end;
    if (start < input.length) yield;
  }
  return bytes;
}

function* decodeMetadataTextSteps(input: string): Generator<void, string | null> {
  const decodedChunks: string[] = [];
  let currentParts: string[] = [];
  let cursor = 0;
  let literalStart = 0;
  let sliceStart = 0;
  while (cursor < input.length) {
    const character = input[cursor];
    if (character === "<") return null;
    if (character === "&") {
      currentParts.push(input.slice(literalStart, cursor));
      const entity = decodeAllowedEntity(input, cursor);
      if (entity === null) return null;
      currentParts.push(entity.value);
      cursor = entity.next;
      literalStart = cursor;
    } else {
      cursor += 1;
    }
    if (cursor - sliceStart >= METADATA_DECODE_CODE_UNITS_PER_STEP) {
      currentParts.push(input.slice(literalStart, cursor));
      decodedChunks.push(currentParts.join(""));
      currentParts = [];
      literalStart = cursor;
      sliceStart = cursor;
      yield;
    }
  }
  currentParts.push(input.slice(literalStart));
  decodedChunks.push(currentParts.join(""));
  return decodedChunks.join("");
}

function decodeAllowedEntity(
  input: string,
  start: number,
): { readonly next: number; readonly value: string } | null {
  if (input.startsWith("&amp;", start)) return { next: start + 5, value: "&" };
  if (input.startsWith("&lt;", start)) return { next: start + 4, value: "<" };
  if (input.startsWith("&gt;", start)) return { next: start + 4, value: ">" };
  return null;
}
