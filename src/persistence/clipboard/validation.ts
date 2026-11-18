import {
  CLIPBOARD_SCHEMA_LIMITS,
  type ClipboardElementBodyV1,
  type InkClipboardV1,
  type InkElementV1,
  type ShapeAnchorV1,
} from "../../domain/schema/public";
import {
  validateInkElementV1Steps,
  validateRuntimeInkElementV1Steps,
} from "../../domain/schema/element-validation";
import { hasReachableDependencyCycle } from "../../domain/schema/dependency-cycle";
import { renderBandOf, RENDER_BANDS } from "../../domain/commands/render-bands";
import {
  validateClipboardResourcesSteps,
  type ClipboardResourceSelection,
} from "./resource-validation";
import { isAnchorTarget, resolveShapeAnchor } from "../../domain/geometry/public";
import { calculateElementBoundsSteps } from "../../domain/geometry/bounds";
import { MAX_ELEMENT_CELLS, spatialCellMembershipCount } from "../../domain/spatial/index";
import type { ClipboardResult, ElementBounds } from "./types";
import { hasMeasuredTextInkBounds } from "../../domain/schema/snapshot-version";

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

function* remapClipboardBodySteps(
  body: unknown,
  id: string,
  clipIds: ReadonlyMap<string, string>,
  allowRuntimeStrokeBuffers: boolean,
  nodesPerStep: number,
  samplesPerStep: number,
): Generator<boolean | void, ClipboardResult<InkElementV1>> {
  if (!isRecord(body)) return failure("Clipboard element body must be an object.");
  if ("id" in body || "createdAt" in body) {
    return failure("Clipboard element body must not contain document identity fields.");
  }
  if (body.kind !== "line" && body.kind !== "arrow") {
    const validate = allowRuntimeStrokeBuffers
      ? validateRuntimeInkElementV1Steps
      : validateInkElementV1Steps;
    const validation = yield* validate(
      { ...body, id, createdAt: 0 },
      { limits: CLIPBOARD_SCHEMA_LIMITS },
      nodesPerStep,
      samplesPerStep,
    );
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
  const validation = yield* validateInkElementV1Steps(
    { ...identityFree, id, createdAt: 0, startConnection: start.value, endConnection: end.value },
    { limits: CLIPBOARD_SCHEMA_LIMITS },
    nodesPerStep,
    samplesPerStep,
  );
  return validation.ok ? { ok: true, value: validation.value } : failure(validation.error.message);
}

interface ValidatedEntry {
  clipId: string;
  body: ClipboardElementBodyV1;
  element: InkElementV1;
  spatial?: ClipboardStrokeFacts["spatial"];
}

export interface ClipboardStrokeFacts {
  readonly element: Extract<InkElementV1, { kind: "stroke" }>;
  readonly spatial: { readonly spatialMemberships: number; readonly spatialOverflow: number };
}

type RuntimeValidation = ClipboardResourceSelection & {
  readonly strokes?: ReadonlyMap<unknown, ClipboardStrokeFacts>;
};

interface AggregateCounts {
  endpoints: number;
  fanout: Map<string, number>;
}

function* clipboardIdentitiesSteps(
  entries: unknown[],
  allowRuntimeSamples: boolean,
): Generator<void, ClipboardResult<Map<string, string>>> {
  if (entries.length === 0 || entries.length > CLIPBOARD_SCHEMA_LIMITS.elements) {
    return failure("Clipboard element count is outside the supported range.");
  }
  const clipIds = new Map<string, string>();
  let strokes = 0;
  let points = 0;
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
    if (isRecord(entry.element) && entry.element.kind === "stroke") {
      strokes += 1;
      const samples = entry.element.points;
      if (Array.isArray(samples) || (allowRuntimeSamples && samples instanceof Float64Array))
        points += samples.length / 3;
      if (
        strokes > CLIPBOARD_SCHEMA_LIMITS.strokes ||
        points > CLIPBOARD_SCHEMA_LIMITS.strokePoints
      )
        return failure("Clipboard stroke limits are exceeded.");
    }
    yield;
  }
  return { ok: true, value: clipIds };
}

function* validateEntriesSteps(
  entries: unknown[],
  runtime: RuntimeValidation | undefined,
  nodesPerStep: number,
  samplesPerStep: number,
): Generator<boolean | void, ClipboardResult<ValidatedEntry[]>> {
  const identities = yield* clipboardIdentitiesSteps(entries, runtime !== undefined);
  if (!identities.ok) return identities;
  const clipIds = identities.value;
  const validated: ValidatedEntry[] = [];
  for (const entry of entries) {
    const wrapper = entry as UnknownRecord;
    const retained = runtime?.strokes?.get(wrapper.element);
    if (retained !== undefined) {
      // The encoder binds its own identity-free body to the exact canonical worker record.
      // File and clipboard stroke coordinates and per-stroke sample limits are identical.
      validated.push({
        clipId: wrapper.clipId as string,
        body: wrapper.element as ClipboardElementBodyV1,
        element: retained.element,
        spatial: retained.spatial,
      });
      yield;
      continue;
    }
    const element = yield* remapClipboardBodySteps(
      wrapper.element,
      clipIds.get(wrapper.clipId as string)!,
      clipIds,
      runtime !== undefined,
      nodesPerStep,
      samplesPerStep,
    );
    if (!element.ok) return element;
    validated.push({
      clipId: wrapper.clipId as string,
      body: wrapper.element as ClipboardElementBodyV1,
      element: element.value,
    });
    yield;
  }
  return { ok: true, value: validated };
}

const validateConnections = (
  body: Extract<ClipboardElementBodyV1, { kind: "line" | "arrow" }>,
  elements: ReadonlyMap<string, InkElementV1>,
  counts: AggregateCounts,
): ClipboardResult<void> => {
  for (const [connection, endpoint] of [
    [body.startConnection, body.start],
    [body.endConnection, body.end],
  ] as const) {
    if (connection === null) continue;
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

function* validateAggregateLimitsSteps(
  entries: readonly ValidatedEntry[],
  samplesPerStep: number,
): Generator<boolean | void, ClipboardResult<readonly ElementBounds[]>> {
  if (hasClipboardConnectionCycle(entries)) {
    return failure("Clipboard linear endpoint connections must not contain self-links or cycles.");
  }
  const counts: AggregateCounts = {
    endpoints: 0,
    fanout: new Map(),
  };
  const elements = new Map(entries.map(({ clipId, element }) => [clipId, element]));
  const bounds: ElementBounds[] = [];
  let cellMemberships = 0;
  let overflowElements = 0;
  for (const { body, element, spatial } of entries) {
    if (body.kind === "line" || body.kind === "arrow") {
      const connectionValidation = validateConnections(body, elements, counts);
      if (!connectionValidation.ok) return connectionValidation;
    }
    if (spatial !== undefined) {
      cellMemberships += spatial.spatialMemberships;
      overflowElements += spatial.spatialOverflow;
      yield;
      continue;
    }
    const steps = calculateElementBoundsSteps(element, samplesPerStep);
    let bound = steps.next();
    while (!bound.done) {
      yield true;
      bound = steps.next();
    }
    const elementBounds = bound.value;
    bounds.push(elementBounds);
    const memberships = spatialCellMembershipCount(elementBounds);
    if (memberships > MAX_ELEMENT_CELLS) overflowElements += 1;
    else cellMemberships += memberships;
    yield;
  }
  if (
    cellMemberships > CLIPBOARD_SCHEMA_LIMITS.spatialIndexCellMemberships ||
    overflowElements > CLIPBOARD_SCHEMA_LIMITS.spatialIndexOverflowElements
  ) {
    return failure("Clipboard spatial-index capacity limits are exceeded.");
  }
  return { ok: true, value: bounds };
}

const hasClipboardConnectionCycle = (entries: readonly ValidatedEntry[]): boolean => {
  const bodies = new Map(entries.map(({ clipId, body }) => [clipId, body]));
  const roots = entries
    .filter(({ body }) => body.kind === "line" || body.kind === "arrow")
    .map(({ clipId }) => clipId);
  return hasReachableDependencyCycle(roots, (id) => clipboardConnectionDependencies(id, bodies));
};

const clipboardConnectionDependencies = (
  id: string,
  bodies: ReadonlyMap<string, ClipboardElementBodyV1>,
): readonly string[] => {
  const body = bodies.get(id);
  if (body?.kind !== "line" && body?.kind !== "arrow") return [];
  return [body.startConnection?.targetClipId, body.endConnection?.targetClipId].filter(
    (targetId): targetId is string => targetId !== undefined,
  );
};

const hasValidRenderBandOrder = (entries: readonly ValidatedEntry[]): boolean => {
  let previousBand = -1;
  for (const { element } of entries) {
    const band = RENDER_BANDS.indexOf(renderBandOf(element));
    if (band < previousBand) return false;
    previousBand = band;
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

function* validateClipboardPayloadSteps(
  value: unknown,
  runtime: RuntimeValidation | undefined,
  nodesPerStep: number,
  samplesPerStep: number,
): Generator<boolean | void, ClipboardResult<InkClipboardV1>> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "format",
      "version",
      "elements",
      ...(value.fontResources === undefined ? [] : ["fontResources"]),
      ...(value.imageResources === undefined ? [] : ["imageResources"]),
    ])
  ) {
    return failure("Clipboard payload root does not match InkClipboardV1.");
  }
  if (
    value.format !== "inkbook-elements" ||
    (value.version !== 1 &&
      value.version !== 2 &&
      value.version !== 3 &&
      value.version !== 4 &&
      value.version !== 5) ||
    !Array.isArray(value.elements)
  ) {
    return failure("Clipboard payload discriminator or version is invalid.");
  }
  const entries = yield* validateEntriesSteps(
    value.elements,
    runtime,
    nodesPerStep,
    samplesPerStep,
  );
  if (!entries.ok) return entries;
  const versions = validateClipboardElementVersions(entries.value, value.version);
  if (!versions.ok) return versions;
  const resources = yield* validateClipboardResourcesSteps(
    value,
    entries.value.map(({ element }) => element),
    runtime ?? {},
  );
  if (!resources.ok) return resources;
  if (!hasValidRenderBandOrder(entries.value)) {
    return failure("Clipboard elements violate fixed render-band order.");
  }
  const limits = yield* validateAggregateLimitsSteps(entries.value, samplesPerStep);
  if (!limits.ok) return limits;
  const payload = value as unknown as InkClipboardV1;
  if (limits.value.length === entries.value.length) validatedBounds.set(payload, limits.value);
  return { ok: true, value: payload };
}

function validateClipboardElementVersions(
  entries: readonly ValidatedEntry[],
  version: number,
): ClipboardResult<void> {
  if (version >= 5) return { ok: true, value: undefined };
  let locked = false;
  let measuredText = false;
  for (const { element } of entries) {
    locked ||= element.locked === true;
    measuredText ||= hasMeasuredTextInkBounds(element);
  }
  if (version < 4 && locked) return failure("Locked elements require clipboard version 4.");
  if (measuredText) return failure("Measured text ink bounds require clipboard version 5.");
  return { ok: true, value: undefined };
}

function validateClipboardPayloadInternal(
  value: unknown,
  allowRuntimeStrokeBuffers: boolean,
): ClipboardResult<InkClipboardV1> {
  const steps = validateClipboardPayloadSteps(
    value,
    allowRuntimeStrokeBuffers ? {} : undefined,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

export async function validateClipboardPayloadSliced(
  value: unknown,
  checkpoint: () => Promise<void> | undefined,
  nodeLimit: number,
  sampleLimit: number,
  runtime?: RuntimeValidation,
): Promise<ClipboardResult<InkClipboardV1>> {
  const steps = validateClipboardPayloadSteps(value, runtime, nodeLimit * 3, sampleLimit);
  let step = steps.next();
  let visited = 0;
  while (!step.done) {
    visited += 1;
    if (step.value === true || visited % nodeLimit === 0) {
      const pending = checkpoint();
      if (pending !== undefined) await pending;
    }
    step = steps.next();
  }
  const pending = checkpoint();
  if (pending !== undefined) await pending;
  return step.value;
}

export const validateClipboardPayload = (value: unknown): ClipboardResult<InkClipboardV1> =>
  validateClipboardPayloadInternal(value, false);

export const validateRuntimeClipboardPayload = (value: unknown): ClipboardResult<InkClipboardV1> =>
  validateClipboardPayloadInternal(value, true);
