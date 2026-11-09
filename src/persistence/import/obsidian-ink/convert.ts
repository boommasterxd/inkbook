import { englishImportWarning } from "./warnings";
import type { ObsidianInkWarningCode } from "./warnings";
import { FILE_SCHEMA_LIMITS } from "../../../domain/schema/constants";
import { validateInkSnapshotV1Steps } from "../../../domain/schema/snapshot-validation";
import type { InkElementV1, InkSnapshotV1 } from "../../../domain/schema/types";
import { measureUtf8BytesSteps } from "../../documents/safe-svg-metadata";
import { parseChunkedJson } from "../../serialization/input/chunked-json-parser";
import { canvasShape, canvasStrokeSteps, type CanvasContext } from "./canvas-elements";
import { background } from "./source-style";
import { readInkSvgMetadataSteps } from "./svg-metadata";
import { canonicalTargetSteps, canvasOrderSteps, sortSourceRecordsSteps } from "./target-elements";
import { tldrawElementSteps, type TldrawElementContext } from "./tldraw-elements";
import {
  array,
  checkpoint,
  completeSteps,
  finite,
  invalid,
  ObsidianInkImportError,
  record,
  text,
  unsupported,
  type ImportOptions,
  type SourceRecord,
} from "./source-values";

export { ObsidianInkImportError } from "./source-values";
export type { ImportOptions } from "./source-values";

const MAXIMUM_SOURCE_CHARACTERS = 16 * 1024 * 1024;
const MAXIMUM_TRANSCRIPT_CHARACTERS = 1024 * 1024;

export interface ObsidianInkImportResult {
  readonly snapshot: InkSnapshotV1;
  readonly warnings: readonly string[];
  readonly warningCodes: readonly ObsidianInkWarningCode[];
  readonly transcript?: string;
}

export async function convertObsidianInk(
  content: string,
  options: ImportOptions,
): Promise<ObsidianInkImportResult> {
  options.signal.throwIfAborted();
  if (!Number.isSafeInteger(options.timestamp) || options.timestamp < 0)
    invalid("Invalid import timestamp.");
  if (content.length > MAXIMUM_SOURCE_CHARACTERS) capacity("Source exceeds the import text limit.");
  const bytes = await completeSteps(measureUtf8BytesSteps(content), options);
  if (bytes > FILE_SCHEMA_LIMITS.totalInputBytes) capacity("Source exceeds the import byte limit.");
  const metadata =
    options.legacyWriting === true
      ? undefined
      : await completeSteps(readInkSvgMetadataSteps(content), options);
  const json = metadata?.json ?? content;
  const value = record(await parseSourceJson(json, options), "Ink source");
  const warnings = new Set<ObsidianInkWarningCode>();
  const elements =
    metadata?.engine === "ink-canvas"
      ? await completeSteps(convertCanvasSteps(value, options.timestamp, warnings), options)
      : await completeSteps(convertTldrawSteps(value, options.timestamp, warnings), options);
  const pageSource =
    metadata?.engine === "ink-canvas" ? value : legacyPageSource(value, metadata?.lineHeight);
  const snapshot: InkSnapshotV1 = {
    format: "inkbook",
    version: 1,
    revision: 0,
    page: {
      innerWidth: 2000,
      margin: 24.3,
      background: background(pageSource, warnings),
      activeBufferLines: 2,
      lockedBufferLines: 1,
    },
    elements,
  };
  const validated = await completeSteps(validateInkSnapshotV1Steps(snapshot), options);
  if (!validated.ok)
    invalid(`Converted source is not a supported Inkbook document: ${validated.error.message}`);
  const transcript = metadata?.transcript ?? legacyTranscript(value);
  if (transcript !== undefined && transcript.length > MAXIMUM_TRANSCRIPT_CHARACTERS)
    capacity("Transcript exceeds the import limit.");
  return {
    snapshot: validated.value,
    warnings: [...warnings].map(englishImportWarning),
    warningCodes: [...warnings],
    ...(transcript === undefined ? {} : { transcript }),
  };
}

async function parseSourceJson(input: string, options: ImportOptions): Promise<unknown> {
  try {
    return await parseChunkedJson(input, {
      signal: options.signal,
      checkpoint: () => checkpoint(options),
      limits: {
        maximumDepth: 32,
        maximumNodes: 8_500_000,
        maximumContainerEntries: 65_536,
        maximumOutputCharacters: MAXIMUM_SOURCE_CHARACTERS,
        maximumStringScratchCharacters: MAXIMUM_TRANSCRIPT_CHARACTERS,
      },
    });
  } catch (error) {
    options.signal.throwIfAborted();
    if (error instanceof ObsidianInkImportError) throw error;
    return invalid("Ink source contains invalid or excessively complex JSON.");
  }
}

function* convertCanvasSteps(
  source: SourceRecord,
  timestamp: number,
  warnings: Set<ObsidianInkWarningCode>,
): Generator<void, InkElementV1[]> {
  const version = finite(source.version, "Canvas version");
  if (version !== 1 && version !== 2 && version !== 3)
    unsupported("Unsupported InkCanvas snapshot version.");
  const context: CanvasContext = {
    version,
    timestamp,
    warnings,
    pointBudget: { remaining: FILE_SCHEMA_LIMITS.strokePoints },
    styles: version === 3 ? array(source.strokeStyles, "Stroke style table") : [],
    timeBase: source.timeBase === undefined ? 0 : finite(source.timeBase, "Timestamp base"),
  };
  const sources = yield* canvasOrderSteps(source);
  if (sources.length > FILE_SCHEMA_LIMITS.elements) capacity("Too many source elements.");
  const highlights: InkElementV1[] = [];
  const content: InkElementV1[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const value = sources[index]!;
    const converted =
      value.kind === "shape"
        ? canvasShape(value, index, context)
        : yield* canvasStrokeSteps(value, index, context);
    const element = yield* canonicalTargetSteps(converted, warnings);
    appendBand(element, highlights, content);
    yield;
  }
  return [...highlights, ...content];
}

function* convertTldrawSteps(
  source: SourceRecord,
  timestamp: number,
  warnings: Set<ObsidianInkWarningCode>,
): Generator<void, InkElementV1[]> {
  const snapshot =
    source.tldraw === undefined ? source : record(source.tldraw, "Legacy tldraw snapshot");
  const store = tldrawStore(snapshot);
  const byId = new Map<string, SourceRecord>();
  let pages = 0;
  for (const [id, value] of Object.entries(store)) {
    const entry = record(value, "Tldraw record");
    if (text(entry.id, "Tldraw id") !== id) invalid("Tldraw record key and id differ.");
    if (entry.typeName === "page") pages += 1;
    byId.set(id, entry);
    yield;
  }
  if (pages > 1) unsupported("Multiple legacy pages cannot be imported into one Inkbook page.");
  const context: TldrawElementContext = {
    timestamp,
    warnings,
    byId,
    pointBudget: { remaining: FILE_SCHEMA_LIMITS.strokePoints },
  };
  const sources = yield* tldrawOrderSteps(byId);
  if (sources.length > FILE_SCHEMA_LIMITS.elements) capacity("Too many legacy elements.");
  const highlights: InkElementV1[] = [];
  const content: InkElementV1[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const element = yield* tldrawElementSteps(sources[index]!, index, context);
    appendBand(yield* canonicalTargetSteps(element, warnings), highlights, content);
  }
  warnings.add("legacyMissingStrokes");
  return [...highlights, ...content];
}

function* tldrawOrderSteps(
  byId: ReadonlyMap<string, SourceRecord>,
): Generator<void, SourceRecord[]> {
  const children = new Map<string, SourceRecord[]>();
  for (const entry of byId.values()) {
    if (entry.typeName !== "shape") continue;
    if (entry.type === "writing-container" || entry.type === "writing-lines") continue;
    const parent = text(entry.parentId, "Shape parent");
    text(entry.index, "Shape order");
    const siblings = children.get(parent) ?? [];
    siblings.push(entry);
    children.set(parent, siblings);
    yield;
  }
  for (const [id, records] of children) children.set(id, yield* sortSourceRecordsSteps(records));
  const roots: SourceRecord[] = [];
  for (const [parent, records] of children) if (parent.startsWith("page:")) roots.push(...records);
  const result: SourceRecord[] = [];
  const pending = roots.reverse();
  const seen = new Set<SourceRecord>();
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (seen.has(entry)) invalid("Cyclic legacy shape hierarchy.");
    seen.add(entry);
    if (entry.type === "group") {
      const nested = children.get(text(entry.id, "Group id")) ?? [];
      for (let index = nested.length - 1; index >= 0; index -= 1) pending.push(nested[index]!);
    } else result.push(entry);
    yield;
  }
  let expected = 0;
  for (const records of children.values()) expected += records.length;
  if (seen.size !== expected) unsupported("Legacy source contains orphaned or cyclic shapes.");
  return result;
}

function tldrawStore(snapshot: SourceRecord): SourceRecord {
  const document =
    snapshot.document === undefined ? undefined : record(snapshot.document, "Tldraw document");
  return record(snapshot.store ?? document?.store, "Tldraw store");
}

function legacyPageSource(source: SourceRecord, lineHeight?: number): SourceRecord {
  const snapshot = source.tldraw === undefined ? source : record(source.tldraw, "Legacy snapshot");
  const document = tldrawStore(snapshot)["document:document"];
  const meta = document === undefined ? undefined : record(document, "Document").meta;
  const height =
    meta === undefined ? undefined : record(meta, "Document metadata").writingLineHeight;
  return { gridEnabled: false, writingLineHeight: height ?? lineHeight ?? 150 };
}

function legacyTranscript(source: SourceRecord): string | undefined {
  if (source.meta === undefined) return undefined;
  const meta = record(source.meta, "Legacy metadata");
  if (meta.fileType !== undefined && meta.fileType !== "inkWriting")
    unsupported("Only handwriting files can be imported.");
  if (meta.transcript === undefined) return undefined;
  if (typeof meta.transcript !== "string") invalid("Invalid source transcript.");
  return meta.transcript;
}

function appendBand(
  element: InkElementV1,
  highlights: InkElementV1[],
  content: InkElementV1[],
): void {
  if (element.kind === "stroke" && element.tool === "highlighter") highlights.push(element);
  else content.push(element);
}

function capacity(message: string): never {
  throw new ObsidianInkImportError("capacity-exceeded", message);
}
