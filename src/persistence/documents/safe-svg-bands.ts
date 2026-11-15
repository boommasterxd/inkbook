import { FILE_SCHEMA_LIMITS } from "../../domain/schema/public";
import { parseOpeningTag, skipWhitespace } from "./svg-tag";
import { accountPath, isBandGroup, validPressureGroup, type SvgTotals } from "./safe-svg-totals";
import { validatePathAttributesSteps } from "./safe-svg-paths";
import { validateTextElementSteps } from "./safe-svg-text";
import { parseSafeAutoAtomSteps } from "./safe-svg-auto-atoms";
import type { SafeAutoPaintReferences } from "./safe-svg-auto-paint";

interface BandContext {
  readonly id: string;
  readonly totals: SvgTotals;
  readonly pathsPerStep: number;
  readonly version: number;
  readonly autoEnabled: boolean;
  readonly autoIds: Set<bigint>;
  readonly references: SafeAutoPaintReferences;
}

export function* parsePathGroupSteps(
  input: string,
  start: number,
  context: BandContext,
  deadlineExceeded?: () => boolean,
): Generator<
  void,
  { readonly next: number; readonly range: { readonly start: number; readonly end: number } } | null
> {
  const { id, totals, pathsPerStep } = context;
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
    if (path?.name === "g" && !isAutoAtom(path, context)) {
      if (!validPressureGroup(path, id, pressurePaths, totals)) return null;
      pressurePaths = 0;
      cursor = skipWhitespace(input, path.next);
      continue;
    }
    const paint = yield* parseBandPaintSteps(
      input,
      cursor,
      path,
      { ...context, pressurePaths },
      deadlineExceeded,
    );
    if (paint === null) return null;
    cursor = skipWhitespace(input, paint.next);
    if (paint.text) continue;
    if (pressurePaths !== null && ++pressurePaths > 1) return null;
    pathsSinceStep += 1;
    if (pathsSinceStep === pathsPerStep) {
      pathsSinceStep = 0;
      yield;
    }
  }
  if (pathsSinceStep > 0) yield;
  return { next: cursor + 4, range: { end: cursor, start: contentStart } };
}

function isAutoAtom(tag: ReturnType<typeof parseOpeningTag>, context: BandContext): boolean {
  return (
    context.autoEnabled &&
    context.id !== "inkbook-background" &&
    tag?.attributes.get("id")?.startsWith("inkbook-auto-atom-") === true
  );
}

function* parseBandPaintSteps(
  input: string,
  cursor: number,
  tag: ReturnType<typeof parseOpeningTag>,
  context: BandContext & { readonly pressurePaths: number | null },
  exhausted?: () => boolean,
): Generator<void, { next: number; text: boolean } | null> {
  if (isAutoAtom(tag, context)) {
    const atom = yield* parseSafeAutoAtomSteps(input, cursor, {
      ids: context.autoIds,
      totals: context.totals,
      references: context.references,
      exhausted,
    });
    return atom === null ? null : { next: atom.next, text: false };
  }
  const text = tag?.name === "text";
  const next = text
    ? yield* parseBandTextSteps(input, cursor, context)
    : yield* parseSinglePathSteps(tag, context.totals, exhausted, context.version);
  return next === null ? null : { next, text };
}

function* parseSinglePathSteps(
  path: ReturnType<typeof parseOpeningTag>,
  totals: SvgTotals,
  deadlineExceeded?: () => boolean,
  version = 1,
): Generator<void, number | null> {
  if (path === null || path.name !== "path" || !path.selfClosing) return null;
  const commands = yield* validatePathAttributesSteps(
    path.attributes,
    deadlineExceeded,
    undefined,
    version,
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
