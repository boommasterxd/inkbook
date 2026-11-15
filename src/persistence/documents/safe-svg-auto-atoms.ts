import { hasExactAttributes, parseOpeningTag, skipWhitespace } from "./svg-tag";
import { validStrokeGroupAttributes } from "./safe-svg-transform";
import { validatePathAttributesSteps } from "./safe-svg-paths";
import { validateTextElementSteps } from "./safe-svg-text";
import { accountPath, type SvgTotals } from "./safe-svg-totals";
import {
  isSafeAutoGeometryPaint,
  type SafeAutoPaintReferences,
  type SafeAutoTile,
  type SafeAutoPaintMode,
  type SafeAutoGeometryReference,
  safeAutoPaintMode,
} from "./safe-svg-auto-paint";
import type { SafeAutoVisitor } from "./safe-svg-auto-definitions";
import { parseSafeAutoPattern, parseSafeAutoTile } from "./safe-svg-auto-patterns";

export const MAXIMUM_AUTO_ATOM_CHARACTERS = 18 * 1024 * 1024;
const ATOM_ID = /^inkbook-auto-atom-([0-9a-f]{64})-(0|[1-9]\d{0,5})$/u;

interface AutoAtomOptions {
  readonly ids: Set<bigint>;
  readonly totals: SvgTotals;
  readonly references: SafeAutoPaintReferences;
  readonly exhausted?: (() => boolean) | undefined;
  readonly visitor?: SafeAutoVisitor | undefined;
}

/** Local references are derived from the atom identity and never point at arbitrary markup. */
export function* parseSafeAutoAtomSteps(
  input: string,
  start: number,
  options: AutoAtomOptions,
): Generator<void, { next: number; minY: number; maxY: number } | null> {
  const identity = parseAtomIdentity(input, start, options.ids);
  if (identity === null) return null;
  const { group, key } = identity;
  options.visitor?.open(group);
  const defs = parseOpeningTag(input, skipWhitespace(input, group.next));
  if (defs?.name !== "defs" || defs.selfClosing || defs.attributes.size !== 0) return null;
  options.visitor?.open(defs);
  const geometryId = `inkbook-auto-geometry-${key}`;
  const geometry = yield* parseGeometrySteps(
    input,
    skipWhitespace(input, defs.next),
    geometryId,
    options,
  );
  if (geometry === null) return null;
  const patterns = yield* parsePaintDefinitionsSteps(
    input,
    skipWhitespace(input, geometry.next),
    key,
    options,
  );
  if (patterns === null) return null;
  const tiles = yield* parseTileInstancesSteps(
    input,
    patterns.next,
    patterns.tiles,
    { id: geometryId, paint: geometry.paint },
    options,
  );
  if (
    tiles === null ||
    !input.startsWith("</g>", tiles.next) ||
    tiles.next + 4 - start > MAXIMUM_AUTO_ATOM_CHARACTERS
  )
    return null;
  options.visitor?.close();
  return { ...tiles, next: tiles.next + 4 };
}

function parseAtomIdentity(
  input: string,
  start: number,
  ids: Set<bigint>,
): {
  group: NonNullable<ReturnType<typeof parseOpeningTag>>;
  key: string;
} | null {
  const group = parseOpeningTag(input, start);
  const id = group?.attributes.get("id");
  const match = id === undefined ? null : ATOM_ID.exec(id);
  if (
    group?.name !== "g" ||
    group.selfClosing ||
    group.attributes.size !== 1 ||
    match === null ||
    ids.size >= 60_004
  )
    return null;
  // Six decimal ordinal digits fit in 20 bits. Numeric keys cannot retain sliced input atoms.
  const identity = (BigInt(`0x${match[1]!}`) << 20n) | BigInt(match[2]!);
  if (ids.has(identity)) return null;
  ids.add(identity);
  return { group, key: `${match[1]!}-${match[2]!}` };
}

function* parsePaintDefinitionsSteps(
  input: string,
  start: number,
  key: string,
  options: AutoAtomOptions,
): Generator<
  void,
  {
    next: number;
    tiles: SafeAutoTile[];
  } | null
> {
  const tiles: SafeAutoTile[] = [];
  let cursor = start;
  while (!input.startsWith("</defs>", cursor)) {
    if (tiles.length === 2048 || cursor - start > MAXIMUM_AUTO_ATOM_CHARACTERS) return null;
    const pattern = parseSafeAutoPattern(
      input,
      cursor,
      `${key}-${tiles.length}`,
      options.references,
      options.visitor,
    );
    if (pattern === null) return null;
    tiles.push(pattern.tile);
    cursor = skipWhitespace(input, pattern.next);
    if (options.exhausted?.() ?? true) yield;
  }
  options.visitor?.close();
  return { next: skipWhitespace(input, cursor + 7), tiles };
}

function* parseTileInstancesSteps(
  input: string,
  start: number,
  tiles: readonly SafeAutoTile[],
  geometry: SafeAutoGeometryReference,
  options: AutoAtomOptions,
): Generator<void, { next: number; minY: number; maxY: number } | null> {
  let cursor = start;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const tile of tiles) {
    const next = parseSafeAutoTile(input, cursor, tile, geometry, options.visitor);
    if (next === null) return null;
    cursor = skipWhitespace(input, next);
    minY = Math.min(minY, Number(tile.box.y));
    maxY = Math.max(maxY, Number(tile.box.y) + Number(tile.box.height));
    if (options.exhausted?.() ?? true) yield;
  }
  return { next: cursor, minY, maxY };
}

function* parseGeometrySteps(
  input: string,
  start: number,
  id: string,
  options: AutoAtomOptions,
): Generator<void, { next: number; paint: SafeAutoPaintMode } | null> {
  const group = parseOpeningTag(input, start);
  if (!isGeometryGroup(group, id)) return null;
  options.visitor?.open(group);
  const startContent = skipWhitespace(input, group.next);
  const tag = parseOpeningTag(input, startContent);
  let next: number | null;
  let paint: SafeAutoPaintMode | null;
  if (tag?.name === "path" && tag.selfClosing) {
    const commands = yield* validatePathAttributesSteps(
      tag.attributes,
      options.exhausted,
      undefined,
      5,
      true,
    );
    if (commands === null || !accountPath(options.totals, commands, tag.attributes.get("d")!))
      return null;
    options.visitor?.open(tag);
    next = tag.next;
    paint = safeAutoPaintMode(tag.attributes.get("class"));
  } else if (tag?.name === "text") {
    next = yield* parseAutoTextSteps(input, startContent, options);
    paint = "fill";
  } else return null;
  if (next === null || paint === null) return null;
  const cursor = skipWhitespace(input, next);
  if (!input.startsWith("</g>", cursor)) return null;
  options.visitor?.close();
  return { next: cursor + 4, paint };
}

function isGeometryGroup(
  group: ReturnType<typeof parseOpeningTag>,
  id: string,
): group is NonNullable<ReturnType<typeof parseOpeningTag>> {
  if (group?.name !== "g" || group.selfClosing) return false;
  const transform = group.attributes.get("transform");
  return (
    hasExactAttributes(group.attributes, {
      id,
      ...(transform === undefined ? {} : { transform }),
    }) &&
    (transform === undefined || validStrokeGroupAttributes(new Map([["transform", transform]])))
  );
}

function* parseAutoTextSteps(
  input: string,
  start: number,
  options: AutoAtomOptions,
): Generator<void, number | null> {
  let spans = 0;
  let auto = false;
  const next = yield* validateTextElementSteps(
    input,
    start,
    {
      open: (tag) => {
        if (tag.name === "tspan") {
          spans++;
          auto = isSafeAutoGeometryPaint(tag.attributes);
        }
        options.visitor?.open(tag);
      },
      close: () => options.visitor?.close(),
      text: (value) => options.visitor?.text?.(value),
      unadjustedText: () => {
        options.totals.unadjustedTextRuns = (options.totals.unadjustedTextRuns ?? 0) + 1;
      },
    },
    true,
  );
  return spans === 1 && auto ? next : null;
}
