import type {
  ClipboardElementBodyV1,
  ClipboardElementV1,
  InkClipboardV1,
  InkElementV1,
} from "../../domain/schema/public";
import { MAX_JSON_DEPTH } from "../../domain/schema/public";
import { CLIPBOARD_LIMITS, INKBOOK_CLIPBOARD_TEXT_PREFIX } from "./constants";
import type {
  ClipboardCandidates,
  ClipboardPayloadSource,
  ClipboardResult,
  DecodedClipboard,
  EncodedClipboard,
} from "./types";
import { validateClipboardPayload, validateRuntimeClipboardPayload } from "./validation";

const encoder = new TextEncoder();
const PLAIN_TEXT_PREFIX_BYTES = encoder.encode(INKBOOK_CLIPBOARD_TEXT_PREFIX).byteLength;

const limitFailure = (message: string): ClipboardResult<never> => ({
  ok: false,
  error: { code: "limit-exceeded", message },
});

const schemaFailure = (message: string): ClipboardResult<never> => ({
  ok: false,
  error: { code: "invalid-schema", message },
});

const compactClipId = (index: number): string => index.toString(36);

const createBody = (
  element: InkElementV1,
  documentIdToClipId: ReadonlyMap<string, string>,
): ClipboardElementBodyV1 => {
  if (element.kind !== "line" && element.kind !== "arrow") {
    const { id: _id, createdAt: _createdAt, ...identityFree } = element;
    return identityFree;
  }

  const {
    id: _id,
    createdAt: _createdAt,
    startConnection: _start,
    endConnection: _end,
    ...linearBody
  } = element;
  const remapConnection = (connection: typeof element.startConnection) => {
    if (connection === null) return null;
    const targetClipId = documentIdToClipId.get(connection.targetId);
    return targetClipId === undefined ? null : { targetClipId, anchor: connection.anchor };
  };
  return {
    ...linearBody,
    startConnection: remapConnection(element.startConnection),
    endConnection: remapConnection(element.endConnection),
  };
};

const createEncoded = (
  payload: InkClipboardV1,
  requirePlainFallbackWithinLimit: boolean,
): ClipboardResult<EncodedClipboard> => {
  const compactJson = serializeClipboardPayload(payload);
  const plainText = `${INKBOOK_CLIPBOARD_TEXT_PREFIX}${compactJson}`;
  const byteLength = encoder.encode(compactJson).byteLength;
  if (
    byteLength > CLIPBOARD_LIMITS.totalInputBytes ||
    (requirePlainFallbackWithinLimit &&
      PLAIN_TEXT_PREFIX_BYTES + byteLength > CLIPBOARD_LIMITS.totalInputBytes)
  ) {
    return limitFailure("Clipboard payload exceeds the 8 MiB input limit.");
  }
  return {
    ok: true,
    value: {
      payload,
      compactJson,
      customText: compactJson,
      plainText,
      byteLength,
      fingerprint: compactJson,
    },
  };
};

const encodeSelectionInternal = (
  elementsInRenderOrder: readonly InkElementV1[],
  selectedIds: ReadonlySet<string>,
  allowRuntimeStrokeBuffers: boolean,
): ClipboardResult<EncodedClipboard> => {
  if (selectedIds.size === 0) {
    return { ok: false, error: { code: "empty-selection", message: "No elements are selected." } };
  }
  const selectedElements = elementsInRenderOrder.filter(({ id }) => selectedIds.has(id));
  if (selectedElements.length !== selectedIds.size) {
    return {
      ok: false,
      error: { code: "missing-selection", message: "The selection contains an unknown element." },
    };
  }
  const documentIdToClipId = new Map(
    selectedElements.map(({ id }, index) => [id, compactClipId(index)] as const),
  );
  const clipboardElements: ClipboardElementV1[] = selectedElements.map((element, index) => ({
    clipId: compactClipId(index),
    element: createBody(element, documentIdToClipId),
  }));
  const payload: InkClipboardV1 = {
    format: "inkbook-elements",
    version: 1,
    elements: clipboardElements,
  };
  const validation = allowRuntimeStrokeBuffers
    ? validateRuntimeClipboardPayload(payload)
    : validateClipboardPayload(payload);
  return validation.ok ? createEncoded(validation.value, true) : validation;
};

export const encodeRuntimeSelection = (
  elementsInRenderOrder: readonly InkElementV1[],
  selectedIds: ReadonlySet<string>,
): ClipboardResult<EncodedClipboard> =>
  encodeSelectionInternal(elementsInRenderOrder, selectedIds, true);

function serializeClipboardPayload(payload: InkClipboardV1): string {
  return serializeCanonicalJson(payload);
}

function serializeCanonicalJson(value: unknown): string {
  if (value instanceof Float64Array) return `[${value.join(",")}]`;
  if (Array.isArray(value)) {
    if (value.length === 0 || value[0] === null || typeof value[0] !== "object") {
      return JSON.stringify(value);
    }
    return `[${value.map(serializeCanonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const properties = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serializeCanonicalJson(record[key])}`);
    return `{${properties.join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Clipboard payload is not JSON serializable.");
  return serialized;
}

const jsonDepthWithinLimit = (text: string): boolean => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) return false;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !inString;
};

const decodeJson = (
  json: string,
  source: ClipboardPayloadSource,
): ClipboardResult<DecodedClipboard> => {
  const byteLength = encoder.encode(json).byteLength;
  if (byteLength > CLIPBOARD_LIMITS.totalInputBytes) {
    return limitFailure("Clipboard input exceeds the 8 MiB input limit.");
  }
  if (!jsonDepthWithinLimit(json)) {
    return schemaFailure("Clipboard JSON nesting is invalid or exceeds 16 levels.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return { ok: false, error: { code: "invalid-json", message: "Clipboard JSON is malformed." } };
  }
  const validation = validateClipboardPayload(parsed);
  if (!validation.ok) return validation;
  const encoded = createEncoded(validation.value, false);
  if (!encoded.ok) return encoded;
  return { ok: true, value: { ...encoded.value, source } };
};

export const decodeCustomClipboardText = (text: string): ClipboardResult<DecodedClipboard> =>
  decodeJson(text, "custom");

const decodePlainClipboardText = (text: string): ClipboardResult<DecodedClipboard> => {
  if (encoder.encode(text).byteLength > CLIPBOARD_LIMITS.totalInputBytes) {
    return limitFailure("Clipboard input exceeds the 8 MiB input limit.");
  }
  if (!text.startsWith(INKBOOK_CLIPBOARD_TEXT_PREFIX)) {
    return {
      ok: false,
      error: { code: "invalid-prefix", message: "Plain text is not an Inkbook elements payload." },
    };
  }
  return decodeJson(text.slice(INKBOOK_CLIPBOARD_TEXT_PREFIX.length), "plain");
};

export const resolveClipboardPayload = (
  candidates: ClipboardCandidates,
): ClipboardResult<DecodedClipboard> => {
  if (candidates.customText !== undefined) {
    const custom = decodeCustomClipboardText(candidates.customText);
    if (custom.ok) return custom;
  }
  if (candidates.plainText !== undefined) {
    const plain = decodePlainClipboardText(candidates.plainText);
    if (plain.ok) return plain;
  }
  if (candidates.sessionText !== undefined) {
    const session = decodeJson(candidates.sessionText, "session");
    if (session.ok) return session;
  }
  return schemaFailure("No valid Inkbook clipboard payload is available.");
};
