import type { SvgTotals } from "./safe-svg-totals";
export { accountPath, isBandGroup, validPressureGroup, type SvgTotals } from "./safe-svg-totals";
import type { ImageResourceV3 } from "../../domain/schema/public";
import {
  parseSafeImageDefinitionsSteps,
  parseSafeImageBandSteps,
  hasSafeImageBand,
} from "./safe-svg-images";
import { hasExactAttributes, parseOpeningTag, skipWhitespace } from "./svg-tag";
export { validatePathAttributesSteps } from "./safe-svg-paths";
import { CANONICAL_THEME_STYLESHEET, isSupportedThemeStylesheet } from "./svg-theme";
import { parseSafeSvgRoot, type SafeSvgRoot, type SafeSvgVersionPolicy } from "./svg-envelope-root";
import { decodeMetadataTextSteps, measureUtf8BytesSteps } from "./safe-svg-metadata";
import { validateFontStylesheetSteps, type SafeSvgFontFace } from "./safe-svg-fonts";
import { parsePathGroupSteps } from "./safe-svg-bands";
import {
  COMPACT_METADATA_ENCODING,
  type SnapshotMetadataEncoding,
} from "../serialization/metadata/stroke-sample-codec";
const MAXIMUM_FILE_BYTES = 64 * 1024 * 1024;
const MAXIMUM_METADATA_BYTES = 60 * 1024 * 1024;
const DEFAULT_PATHS_PER_STEP = 128;
const MARKUP_CODE_UNITS_PER_STEP = 256 * 1024;
interface SafeSvgPrefix {
  readonly imageResources?: readonly ImageResourceV3[];
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
  Record<"background" | "content" | "highlights", SafeSvgGroupRange> & {
    readonly images?: SafeSvgGroupRange;
  }
>;
export interface SafeSvgValidationStepOptions {
  readonly deadlineExceeded?: () => boolean;
  readonly pathsPerStep?: number;
  readonly totalInputBytes?: number;
  readonly versionPolicy?: SafeSvgVersionPolicy;
}

export interface SafeSvgValidation {
  readonly imageResources?: readonly ImageResourceV3[];
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
    imageResources?: readonly ImageResourceV3[];
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

export function validateSafeSvg(svg: string): SafeSvgValidation | null {
  return completeValidation(validateSafeSvgSteps(svg));
}

/** Validates the bounded root, stylesheet, and opening metadata tag without retaining static paths. */
export function* validateEditableSafeSvgPreludeSteps(
  prefix: string,
): Generator<void, SafeSvgPrelude | null> {
  const root = parseOpeningTag(prefix, skipWhitespace(prefix, 0));
  const synthetic =
    `${prefix}</metadata>` +
    '<g id="inkbook-background"></g>' +
    (Number(root?.attributes.get("data-inkbook-version")) >= 3
      ? '<g id="inkbook-images-band"></g>'
      : "") +
    '<g id="inkbook-highlights"></g>' +
    '<g id="inkbook-content"></g></svg>';
  const safe = yield* validateSvgStructureSteps(synthetic, { versionPolicy: "editable" });
  return safe === null
    ? null
    : {
        ...(safe.fontStylesheet === undefined ? {} : { fontStylesheet: safe.fontStylesheet }),
        ...(safe.fontFaces === undefined ? {} : { fontFaces: safe.fontFaces }),
        ...(safe.imageResources === undefined ? {} : { imageResources: safe.imageResources }),
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
  return yield* validateSvgStructureSteps(svg, options);
}

function* validateSvgStructureSteps(
  svg: string,
  options: SafeSvgValidationStepOptions,
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
  const bands = [
    "inkbook-background",
    ...(hasSafeImageBand(svg, prefix.root.version) ? ["inkbook-images-band"] : []),
    "inkbook-highlights",
    "inkbook-content",
  ];
  for (const group of bands) {
    const parsedGroup =
      group === "inkbook-images-band"
        ? yield* parseSafeImageBandSteps(
            svg,
            cursor,
            prefix.imageResources ?? [],
            totals,
            options.deadlineExceeded,
          )
        : yield* parsePathGroupSteps(
            svg,
            cursor,
            {
              id: group,
              totals,
              pathsPerStep,
              version: prefix.root.version,
            },
            options.deadlineExceeded,
          );
    if (parsedGroup === null) {
      return null;
    }
    const key = (
      group === "inkbook-images-band" ? "images" : group.replace("inkbook-", "")
    ) as keyof SafeSvgGroupRanges;
    groups[key] = parsedGroup.range;
    cursor = skipWhitespace(svg, parsedGroup.next);
  }
  if (!validCompleteEnvelope(svg, cursor)) return null;
  return {
    ...safeResourceFields(prefix),
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

function validCompleteEnvelope(svg: string, cursor: number): boolean {
  return svg.startsWith("</svg>", cursor) && skipWhitespace(svg, cursor + 6) === svg.length;
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
  const fonts = yield* parseOptionalFontsSteps(svg, cursor, root.version);
  if (fonts === null) return null;
  cursor = fonts.cursor;
  const images = yield* parseOptionalImageDefinitionsSteps(svg, cursor, root.version);
  if (images === null) return null;
  cursor = images.cursor;
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
        ...images.fields,
        ...fonts.fields,
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

function safeResourceFields(
  source: Pick<SafeSvgPrefix, "imageResources" | "fontFaces" | "fontStylesheet">,
) {
  return {
    ...(source.imageResources === undefined ? {} : { imageResources: source.imageResources }),
    ...(source.fontFaces === undefined ? {} : { fontFaces: source.fontFaces }),
    ...(source.fontStylesheet === undefined ? {} : { fontStylesheet: source.fontStylesheet }),
  };
}

function* parseOptionalImageDefinitionsSteps(
  svg: string,
  cursor: number,
  version: number,
): Generator<void, { cursor: number; fields: Pick<SafeSvgPrefix, "imageResources"> } | null> {
  if (!svg.startsWith('<defs id="inkbook-images"', cursor)) return { cursor, fields: {} };
  if (version < 3) return null;
  const images = yield* parseSafeImageDefinitionsSteps(svg, cursor);
  return images === null
    ? null
    : {
        cursor: skipWhitespace(svg, images.next),
        fields: { imageResources: images.resources },
      };
}

function* parseOptionalFontsSteps(
  svg: string,
  start: number,
  version: number,
): Generator<
  void,
  {
    cursor: number;
    fields: Pick<SafeSvgPrefix, "fontStylesheet" | "fontFaces">;
  } | null
> {
  let cursor = start;
  let fontStylesheet: string | undefined;
  let fontFaces: SafeSvgFontFace[] | undefined;
  if (svg.startsWith('<style id="inkbook-fonts">', cursor)) {
    const fonts = expectTextElement(svg, cursor, "style", { id: "inkbook-fonts" });
    fontFaces = [];
    const parsedFaces = fontFaces;
    if (
      version < 2 ||
      fonts === null ||
      !(yield* validateFontStylesheetSteps(fonts.text, (face) => parsedFaces.push(face)))
    )
      return null;
    fontStylesheet = fonts.text;
    cursor = skipWhitespace(svg, fonts.next);
  }

  return {
    cursor,
    fields: {
      ...(fontStylesheet === undefined ? {} : { fontStylesheet }),
      ...(fontFaces === undefined ? {} : { fontFaces }),
    },
  };
}
