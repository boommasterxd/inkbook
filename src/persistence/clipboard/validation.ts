import {
  CLIPBOARD_SCHEMA_LIMITS,
  validateInkElementV1,
  type ClipboardElementBodyV1,
  type InkClipboardV1,
  type InkElementV1,
  type ShapeAnchorV1,
} from "../../domain/schema/public";
import { validateRuntimeInkElementV1 } from "../../domain/schema/element-validation";
import {
  calculateElementBounds,
  isAnchorTarget,
  resolveShapeAnchor,
} from "../../domain/geometry/public";
import { measureSpatialCapacity } from "../../domain/spatial/index";
import type { ClipboardResult, ElementBounds } from "./types";

type UnknownRecord = Record<string, unknown>;
const validatedBounds = new WeakMap<InkClipboardV1, readonly ElementBounds[]>();

export const getValidatedClipboardBounds = (
  payload: InkClipboardV1,
): readonly ElementBounds[] | null => validatedBounds.get(payload) ?? null;

const failure = (message: string): ClipboardResult<never> => ({
  ok: false,
  error: { code: "invalid-schema", message },
});

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (record: UnknownRecord, keys: readonly string[]): boolean => {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

const placeholderUuid = (index: number): string =>
  `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

const remapClipboardBody = (
  body: unknown,
  id: string,
  clipIds: ReadonlyMap<string, string>,
  allowRuntimeStrokeBuffers: boolean,
): ClipboardResult<InkElementV1> => {
  if (!isRecord(body)) return failure("Clipboard element body must be an object.");
  if ("id" in body || "createdAt" in body) {
    return failure("Clipboard element body must not contain document identity fields.");
  }
  if (body.kind !== "line" && body.kind !== "arrow") {
    const validation = allowRuntimeStrokeBuffers
      ? validateRuntimeInkElementV1(
          { ...body, id, createdAt: 0 },
          { limits: CLIPBOARD_SCHEMA_LIMITS },
        )
      : validateInkElementV1({ ...body, id, createdAt: 0 }, { limits: CLIPBOARD_SCHEMA_LIMITS });
    return validation.ok
      ? { ok: true, value: validation.value }
      : failure(validation.error.message);
  }
  const remapConnection = (value: unknown): ClipboardResult<unknown> => {
    if (value === null) return { ok: true, value: null };
    if (!isRecord(value) || !hasExactKeys(value, ["targetClipId", "anchor"])) {
      return failure("Clipboard endpoint connection is invalid.");
    }
    if (typeof value.targetClipId !== "string")
      return failure("Connection targetClipId is invalid.");
    const targetId = clipIds.get(value.targetClipId);
    if (targetId === undefined) return failure("Clipboard connection target does not exist.");
    return { ok: true, value: { targetId, anchor: value.anchor } };
  };
  const start = remapConnection(body.startConnection);
  if (!start.ok) return start;
  const end = remapConnection(body.endConnection);
  if (!end.ok) return end;
  const {
    startConnection: _startConnection,
    endConnection: _endConnection,
    ...identityFree
  } = body;
  const validation = validateInkElementV1(
    {
      ...identityFree,
      id,
      createdAt: 0,
      startConnection: start.value,
      endConnection: end.value,
    },
    { limits: CLIPBOARD_SCHEMA_LIMITS },
  );
  return validation.ok ? { ok: true, value: validation.value } : failure(validation.error.message);
};

const polygonVertices = (kind: string): number => {
  if (kind === "triangle") return 3;
  if (kind === "diamond" || kind === "parallelogram") return 4;
  if (kind === "octagon") return 8;
  return 0;
};

const isCompatibleAnchor = (target: ClipboardElementBodyV1, anchor: ShapeAnchorV1): boolean => {
  if (target.kind === "rectangle" || target.kind === "table") return anchor.kind === "box";
  if (target.kind === "ellipse") return anchor.kind === "ellipse-cardinal";
  const vertices = polygonVertices(target.kind);
  if (vertices > 0) {
    return (
      (anchor.kind === "polygon-vertex" || anchor.kind === "polygon-edge-midpoint") &&
      anchor.index < vertices
    );
  }
  if (target.kind !== "coordinate-system") return false;
  return (
    anchor.kind === "coordinate-origin" ||
    (anchor.kind === "coordinate-axis-end" && anchor.index < target.axes.length)
  );
};

interface ValidatedEntry {
  clipId: string;
  body: ClipboardElementBodyV1;
  element: InkElementV1;
}

interface AggregateCounts {
  strokes: number;
  points: number;
  endpoints: number;
  fanout: Map<string, number>;
}

const validateEntries = (
  entries: unknown[],
  allowRuntimeStrokeBuffers: boolean,
): ClipboardResult<ValidatedEntry[]> => {
  if (entries.length === 0 || entries.length > CLIPBOARD_SCHEMA_LIMITS.elements) {
    return failure("Clipboard element count is outside the supported range.");
  }
  const clipIds = new Map<string, string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isRecord(entry) || !hasExactKeys(entry, ["clipId", "element"])) {
      return failure("Clipboard element wrapper is invalid.");
    }
    if (
      typeof entry.clipId !== "string" ||
      entry.clipId.length === 0 ||
      clipIds.has(entry.clipId)
    ) {
      return failure("Clipboard clipId values must be non-empty and unique.");
    }
    clipIds.set(entry.clipId, placeholderUuid(index));
  }
  const validated: ValidatedEntry[] = [];
  for (const entry of entries) {
    const wrapper = entry as UnknownRecord;
    const element = remapClipboardBody(
      wrapper.element,
      clipIds.get(wrapper.clipId as string)!,
      clipIds,
      allowRuntimeStrokeBuffers,
    );
    if (!element.ok) return element;
    validated.push({
      clipId: wrapper.clipId as string,
      body: wrapper.element as ClipboardElementBodyV1,
      element: element.value,
    });
  }
  return { ok: true, value: validated };
};

const validateConnections = (
  body: Extract<ClipboardElementBodyV1, { kind: "line" | "arrow" }>,
  bodies: ReadonlyMap<string, ClipboardElementBodyV1>,
  elements: ReadonlyMap<string, InkElementV1>,
  counts: AggregateCounts,
): ClipboardResult<void> => {
  for (const [connection, endpoint] of [
    [body.startConnection, body.start],
    [body.endConnection, body.end],
  ] as const) {
    if (connection === null) continue;
    const target = bodies.get(connection.targetClipId);
    if (target === undefined || !isCompatibleAnchor(target, connection.anchor)) {
      return failure("Clipboard connection has a missing or incompatible target.");
    }
    const targetElement = elements.get(connection.targetClipId);
    if (
      targetElement === undefined ||
      !connectionMatches(targetElement, connection.anchor, endpoint)
    ) {
      return failure("Clipboard connection endpoint does not match its resolved anchor.");
    }
    counts.endpoints += 1;
    const targetFanout = (counts.fanout.get(connection.targetClipId) ?? 0) + 1;
    counts.fanout.set(connection.targetClipId, targetFanout);
    if (
      counts.endpoints > CLIPBOARD_SCHEMA_LIMITS.connectedEndpoints ||
      targetFanout > CLIPBOARD_SCHEMA_LIMITS.connectedEndpointsPerTarget
    ) {
      return failure("Clipboard connected-endpoint limits are exceeded.");
    }
  }
  return { ok: true, value: undefined };
};

const validateAggregateLimits = (
  entries: readonly ValidatedEntry[],
): ClipboardResult<readonly ElementBounds[]> => {
  const counts: AggregateCounts = {
    strokes: 0,
    points: 0,
    endpoints: 0,
    fanout: new Map(),
  };
  const bodies = new Map(entries.map(({ clipId, body }) => [clipId, body]));
  const elements = new Map(entries.map(({ clipId, element }) => [clipId, element]));
  for (const { body, element } of entries) {
    if (element.kind === "stroke") {
      counts.strokes += 1;
      counts.points += element.points.length / 3;
      if (
        counts.strokes > CLIPBOARD_SCHEMA_LIMITS.strokes ||
        counts.points > CLIPBOARD_SCHEMA_LIMITS.strokePoints
      ) {
        return failure("Clipboard stroke limits are exceeded.");
      }
    }
    if (body.kind !== "line" && body.kind !== "arrow") continue;
    const connectionValidation = validateConnections(body, bodies, elements, counts);
    if (!connectionValidation.ok) return connectionValidation;
  }
  const bounds = entries.map(({ element }) => calculateElementBounds(element));
  const spatial = measureSpatialCapacity(bounds);
  if (
    spatial.cellMemberships > CLIPBOARD_SCHEMA_LIMITS.spatialIndexCellMemberships ||
    spatial.overflowElements > CLIPBOARD_SCHEMA_LIMITS.spatialIndexOverflowElements
  ) {
    return failure("Clipboard spatial-index capacity limits are exceeded.");
  }
  return { ok: true, value: bounds };
};

const hasValidRenderBandOrder = (entries: readonly ValidatedEntry[]): boolean => {
  let contentStarted = false;
  for (const { element } of entries) {
    const isHighlight =
      element.kind === "straight-highlighter" ||
      (element.kind === "stroke" && element.tool === "highlighter");
    if (isHighlight && contentStarted) return false;
    if (!isHighlight) contentStarted = true;
  }
  return true;
};

const connectionMatches = (
  target: InkElementV1,
  anchor: ShapeAnchorV1,
  endpoint: { x: number; y: number },
): boolean => {
  if (!isAnchorTarget(target)) return false;
  const resolved = resolveShapeAnchor(target, anchor);
  return resolved !== null && Math.hypot(resolved.x - endpoint.x, resolved.y - endpoint.y) <= 0.001;
};

const validateClipboardPayloadInternal = (
  value: unknown,
  allowRuntimeStrokeBuffers: boolean,
): ClipboardResult<InkClipboardV1> => {
  if (!isRecord(value) || !hasExactKeys(value, ["format", "version", "elements"])) {
    return failure("Clipboard payload root does not match InkClipboardV1.");
  }
  if (
    value.format !== "inkbook-elements" ||
    value.version !== 1 ||
    !Array.isArray(value.elements)
  ) {
    return failure("Clipboard payload discriminator or version is invalid.");
  }
  const entries = validateEntries(value.elements, allowRuntimeStrokeBuffers);
  if (!entries.ok) return entries;
  if (!hasValidRenderBandOrder(entries.value)) {
    return failure("Clipboard elements violate fixed render-band order.");
  }
  const limits = validateAggregateLimits(entries.value);
  if (!limits.ok) return limits;
  const payload = value as unknown as InkClipboardV1;
  validatedBounds.set(payload, limits.value);
  return { ok: true, value: payload };
};

export const validateClipboardPayload = (value: unknown): ClipboardResult<InkClipboardV1> =>
  validateClipboardPayloadInternal(value, false);

export const validateRuntimeClipboardPayload = (value: unknown): ClipboardResult<InkClipboardV1> =>
  validateClipboardPayloadInternal(value, true);
