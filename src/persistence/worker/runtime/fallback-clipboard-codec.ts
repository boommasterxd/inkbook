import type {
  ClipboardElementBodyV1,
  ClipboardElementV1,
  InkClipboardV1,
  InkElementV1,
} from "../../../domain/schema/public";
import { MAX_JSON_DEPTH } from "../../../domain/schema/public";
import { CLIPBOARD_LIMITS, INKBOOK_CLIPBOARD_TEXT_PREFIX } from "../../clipboard/constants";
import type {
  ClipboardCandidates,
  ClipboardPayloadSource,
  ClipboardResult,
  ClipboardWritePayload,
  DecodedClipboard,
} from "../../clipboard/types";
import { validateClipboardPayload } from "../../clipboard/validation";
import { parseChunkedJson } from "../../serialization/chunked-json-parser";
import type { RuntimeSliceContext } from "./types";

const encoder = new TextEncoder();
const JSON_CHUNK_CODE_UNITS = 16 * 1024;
const CHECKPOINT_INTERVAL = 256;

export async function encodeRuntimeSelectionChunked(
  elementsInRenderOrder: readonly InkElementV1[],
  selectedIds: readonly string[],
  context: RuntimeSliceContext,
): Promise<ClipboardResult<ClipboardWritePayload>> {
  const selection = new Set(selectedIds);
  if (selection.size === 0) return clipboardFailure("empty-selection", "No elements are selected.");
  const selected: InkElementV1[] = [];
  for (let index = 0; index < elementsInRenderOrder.length; index += 1) {
    if (selection.has(elementsInRenderOrder[index]!.id))
      selected.push(elementsInRenderOrder[index]!);
    await periodicCheckpoint(index, context);
  }
  if (selected.length !== selection.size) {
    return clipboardFailure("missing-selection", "The selection contains an unknown element.");
  }
  const documentIds = new Map<string, string>();
  for (let index = 0; index < selected.length; index += 1) {
    documentIds.set(selected[index]!.id, compactClipId(index));
    await periodicCheckpoint(index, context);
  }
  const clipboardElements: ClipboardElementV1[] = [];
  for (let index = 0; index < selected.length; index += 1) {
    const element = selected[index]!;
    clipboardElements.push({
      clipId: compactClipId(index),
      element: createBody(element, documentIds),
    });
    await periodicCheckpoint(index, context);
  }
  const encoded = await serializeClipboardPayload(
    { elements: clipboardElements, format: "inkbook-elements", version: 1 },
    context,
    true,
  );
  if (!encoded.ok) return encoded;
  return {
    ok: true,
    value: {
      byteLength: encoded.value.byteLength,
      customText: encoded.value.text,
      plainText: `${INKBOOK_CLIPBOARD_TEXT_PREFIX}${encoded.value.text}`,
    },
  };
}

export async function decodeClipboardChunked(
  candidates: ClipboardCandidates,
  context: RuntimeSliceContext,
): Promise<ClipboardResult<DecodedClipboard>> {
  for (const candidate of clipboardCandidates(candidates)) {
    const decoded = await decodeCandidate(candidate.text, candidate.source, context);
    if (decoded.ok) return decoded;
  }
  return clipboardFailure("invalid-schema", "No valid Inkbook clipboard payload is available.");
}

async function decodeCandidate(
  input: string,
  source: ClipboardPayloadSource,
  context: RuntimeSliceContext,
): Promise<ClipboardResult<DecodedClipboard>> {
  const json =
    source === "plain"
      ? input.startsWith(INKBOOK_CLIPBOARD_TEXT_PREFIX)
        ? input.slice(INKBOOK_CLIPBOARD_TEXT_PREFIX.length)
        : null
      : input;
  if (json === null) return clipboardFailure("invalid-prefix", "Plain text is not Inkbook data.");
  const inputBytes = await utf8ByteLength(json, context);
  if (inputBytes > CLIPBOARD_LIMITS.totalInputBytes) {
    return clipboardFailure("limit-exceeded", "Clipboard input exceeds the 8 MiB input limit.");
  }
  let value: unknown;
  try {
    value = await parseChunkedJson(json, {
      batchCharacters: JSON_CHUNK_CODE_UNITS,
      checkpoint: context.checkpoint,
      limits: {
        maximumContainerEntries: CLIPBOARD_LIMITS.pointsPerStroke * 3,
        maximumDepth: MAX_JSON_DEPTH,
        maximumNodes: CLIPBOARD_LIMITS.strokePoints * 4 + CLIPBOARD_LIMITS.elements * 64,
        maximumOutputCharacters: CLIPBOARD_LIMITS.totalInputBytes,
        maximumStringScratchCharacters: JSON_CHUNK_CODE_UNITS,
      },
      signal: context.signal,
    });
  } catch {
    return clipboardFailure("invalid-json", "Clipboard JSON is malformed.");
  }
  await context.checkpoint();
  const validated = validateClipboardPayload(value);
  if (!validated.ok) return validated;
  await context.checkpoint();
  const canonical = await serializeClipboardPayload(validated.value, context, false);
  if (!canonical.ok) return canonical;
  return {
    ok: true,
    value: {
      byteLength: canonical.value.byteLength,
      compactJson: canonical.value.text,
      customText: canonical.value.text,
      fingerprint: canonical.value.text,
      payload: validated.value,
      plainText: `${INKBOOK_CLIPBOARD_TEXT_PREFIX}${canonical.value.text}`,
      source,
    },
  };
}

async function serializeClipboardPayload(
  payload: InkClipboardV1,
  context: RuntimeSliceContext,
  requirePlainFallbackWithinLimit: boolean,
): Promise<ClipboardResult<{ readonly byteLength: number; readonly text: string }>> {
  const writer = new CanonicalJsonWriter(context);
  await writer.write(payload);
  const result = await writer.finish();
  const prefixBytes = encoder.encode(INKBOOK_CLIPBOARD_TEXT_PREFIX).byteLength;
  if (
    result.byteLength > CLIPBOARD_LIMITS.totalInputBytes ||
    (requirePlainFallbackWithinLimit &&
      result.byteLength + prefixBytes > CLIPBOARD_LIMITS.totalInputBytes)
  ) {
    return clipboardFailure("limit-exceeded", "Clipboard payload exceeds the 8 MiB input limit.");
  }
  return { ok: true, value: result };
}

class CanonicalJsonWriter {
  readonly #chunks: string[] = [];
  readonly #context: RuntimeSliceContext;
  #current = "";
  #nodes = 0;

  public constructor(context: RuntimeSliceContext) {
    this.#context = context;
  }

  public async write(value: unknown): Promise<void> {
    this.#context.signal.throwIfAborted();
    this.#nodes += 1;
    if (this.#nodes % CHECKPOINT_INTERVAL === 0) await this.#context.checkpoint();
    if (value instanceof Float64Array || Array.isArray(value)) {
      await this.#writeArray(value);
      return;
    }
    if (value !== null && typeof value === "object") {
      await this.#writeObject(value as Record<string, unknown>);
      return;
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("Clipboard payload is not serializable.");
    this.#append(serialized);
  }

  public async finish(): Promise<{ readonly byteLength: number; readonly text: string }> {
    this.#flush();
    let text = "";
    let byteLength = 0;
    for (let index = 0; index < this.#chunks.length; index += 1) {
      const chunk = this.#chunks[index]!;
      text += chunk;
      byteLength += encoder.encode(chunk).byteLength;
      await periodicCheckpoint(index, this.#context);
    }
    return { byteLength, text };
  }

  async #writeArray(value: ArrayLike<unknown>): Promise<void> {
    this.#append("[");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) this.#append(",");
      await this.write(value[index]);
    }
    this.#append("]");
  }

  async #writeObject(value: Record<string, unknown>): Promise<void> {
    this.#append("{");
    const keys = Object.keys(value).sort();
    for (let index = 0; index < keys.length; index += 1) {
      if (index > 0) this.#append(",");
      const key = keys[index]!;
      this.#append(`${JSON.stringify(key)}:`);
      await this.write(value[key]);
    }
    this.#append("}");
  }

  #append(value: string): void {
    this.#current += value;
    if (this.#current.length >= JSON_CHUNK_CODE_UNITS) this.#flush();
  }

  #flush(): void {
    if (this.#current.length === 0) return;
    this.#chunks.push(this.#current);
    this.#current = "";
  }
}

function createBody(
  element: InkElementV1,
  documentIds: ReadonlyMap<string, string>,
): ClipboardElementBodyV1 {
  if (element.kind !== "line" && element.kind !== "arrow") {
    const { createdAt: _createdAt, id: _id, ...body } = element;
    return body;
  }
  const { createdAt: _createdAt, endConnection, id: _id, startConnection, ...body } = element;
  const remap = (connection: typeof startConnection) => {
    if (connection === null) return null;
    const targetClipId = documentIds.get(connection.targetId);
    return targetClipId === undefined ? null : { anchor: connection.anchor, targetClipId };
  };
  return {
    ...body,
    endConnection: remap(endConnection),
    startConnection: remap(startConnection),
  };
}

function clipboardCandidates(
  candidates: ClipboardCandidates,
): readonly { readonly source: ClipboardPayloadSource; readonly text: string }[] {
  const available: { source: ClipboardPayloadSource; text: string }[] = [];
  if (candidates.customText !== undefined)
    available.push({ source: "custom", text: candidates.customText });
  if (candidates.plainText !== undefined)
    available.push({ source: "plain", text: candidates.plainText });
  if (candidates.sessionText !== undefined)
    available.push({ source: "session", text: candidates.sessionText });
  return available;
}

async function utf8ByteLength(value: string, context: RuntimeSliceContext): Promise<number> {
  let bytes = 0;
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + JSON_CHUNK_CODE_UNITS);
    const trailing = value.charCodeAt(end - 1);
    if (end < value.length && trailing >= 0xd800 && trailing <= 0xdbff) end -= 1;
    bytes += encoder.encode(value.slice(offset, end)).byteLength;
    if (bytes > CLIPBOARD_LIMITS.totalInputBytes) return bytes;
    await context.checkpoint();
    offset = end;
  }
  return bytes;
}

async function periodicCheckpoint(index: number, context: RuntimeSliceContext): Promise<void> {
  if ((index + 1) % CHECKPOINT_INTERVAL === 0) await context.checkpoint();
}

function compactClipId(index: number): string {
  return index.toString(36);
}

function clipboardFailure(
  code:
    | "empty-selection"
    | "invalid-json"
    | "invalid-prefix"
    | "invalid-schema"
    | "limit-exceeded"
    | "missing-selection",
  message: string,
): ClipboardResult<never> {
  return { error: { code, message }, ok: false };
}
