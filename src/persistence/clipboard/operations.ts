import type {
  ClipboardElementBodyV1,
  EndpointConnectionV1,
  InkElementV1,
  PageV1,
  PointV1,
} from "../../domain/schema/public";
import { FILE_SCHEMA_LIMITS, validateInkElementV1 } from "../../domain/schema/public";
import {
  calculateElementBounds,
  derivePageExtent,
  translateElementGeometry,
} from "../../domain/geometry/public";
import { measureSpatialCapacity, type SpatialBounds } from "../../domain/spatial/index";
import { DOCUMENT_LIMITS, REPEATED_PASTE_OFFSET } from "./constants";
import type {
  ClipboardOperationIdentity,
  ClipboardResult,
  ClipboardShortcutAction,
  ClipboardShortcutContext,
  CurrentClipboardState,
  CutGuard,
  DecodedClipboard,
  ElementBounds,
  PastePlan,
  PasteInvocation,
  PasteRepeatState,
  VersionedSelectionRecord,
} from "./types";
import { getValidatedClipboardBounds } from "./validation";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface PlanPasteOptions {
  decoded: DecodedClipboard;
  existingElements: readonly InkElementV1[];
  page: PageV1;
  target: PointV1;
  commandTimestamp: number;
  createId: () => string;
  previousRepeat?: PasteRepeatState;
}

export interface ValidatePasteAdoptionOptions {
  plan: PastePlan;
  resultIdentity: ClipboardOperationIdentity;
  current: ClipboardOperationIdentity;
  currentElements: readonly InkElementV1[];
  page: PageV1;
}

export const resolvePasteTarget = (invocation: PasteInvocation): PointV1 => {
  if (invocation.kind === "context-menu") return invocation.invocationPoint;
  if (invocation.kind === "shortcut" && invocation.lastSessionPointer !== null) {
    return invocation.lastSessionPointer;
  }
  return invocation.visibleCanvasCenter;
};

export const shouldHandleClipboardShortcut = (
  action: ClipboardShortcutAction,
  context: ClipboardShortcutContext,
): boolean => {
  if (!context.pointerOverActiveEditor || context.textFieldFocused) return false;
  return action === "paste" ? context.hasValidInkPayload : context.hasSelection;
};

const failure = (message: string): ClipboardResult<never> => ({
  ok: false,
  error: { code: "limit-exceeded", message },
});

const round3 = (value: number): number => {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
};

const unionBounds = <T>(
  elements: readonly T[],
  boundsForElement: (element: T) => ElementBounds,
): ElementBounds => {
  const first = boundsForElement(elements[0]!);
  return elements.slice(1).reduce<ElementBounds>((bounds, element) => {
    const next = boundsForElement(element);
    return {
      minX: Math.min(bounds.minX, next.minX),
      minY: Math.min(bounds.minY, next.minY),
      maxX: Math.max(bounds.maxX, next.maxX),
      maxY: Math.max(bounds.maxY, next.maxY),
    };
  }, first);
};

const unionElementBounds = (bounds: readonly ElementBounds[]): ElementBounds =>
  unionBounds(bounds, (value) => value);

const translateBounds = (
  bounds: Readonly<ElementBounds>,
  translation: Readonly<PointV1>,
): ElementBounds => ({
  maxX: bounds.maxX + translation.x,
  maxY: bounds.maxY + translation.y,
  minX: bounds.minX + translation.x,
  minY: bounds.minY + translation.y,
});

const remapConnection = (
  connection: { targetClipId: string; anchor: EndpointConnectionV1["anchor"] } | null,
  ids: ReadonlyMap<string, string>,
): EndpointConnectionV1 | null => {
  if (connection === null) return null;
  const targetId = ids.get(connection.targetClipId);
  return targetId === undefined ? null : { targetId, anchor: connection.anchor };
};

const adoptBody = (
  body: ClipboardElementBodyV1,
  id: string,
  createdAt: number,
  ids: ReadonlyMap<string, string>,
): InkElementV1 => {
  if (body.kind !== "line" && body.kind !== "arrow") {
    return { ...body, id, createdAt };
  }
  const { startConnection, endConnection, ...rest } = body;
  return {
    ...rest,
    id,
    createdAt,
    startConnection: remapConnection(startConnection, ids),
    endConnection: remapConnection(endConnection, ids),
  };
};

const countDocumentLimits = (
  existing: readonly InkElementV1[],
  inserted: readonly InkElementV1[],
  page: PageV1,
  insertedBounds?: readonly ElementBounds[],
): ClipboardResult<void> => {
  if (existing.length + inserted.length > DOCUMENT_LIMITS.elements)
    return failure("Document element limit is exceeded.");
  let strokes = 0;
  let points = 0;
  let endpoints = 0;
  let maximumBottom: number | null = null;
  const fanout = new Map<string, number>();
  const spatialBounds: SpatialBounds[] = [];
  for (const [element, bounds] of documentElements(existing, inserted, insertedBounds)) {
    if (element.kind === "stroke") {
      strokes += 1;
      points += element.points.length / 3;
    }
    if (element.kind === "line" || element.kind === "arrow") {
      for (const connection of [element.startConnection, element.endConnection]) {
        if (connection === null) continue;
        endpoints += 1;
        fanout.set(connection.targetId, (fanout.get(connection.targetId) ?? 0) + 1);
      }
    }
    spatialBounds.push(bounds);
    maximumBottom = Math.max(maximumBottom ?? bounds.maxY, bounds.maxY);
  }
  if (strokes > DOCUMENT_LIMITS.strokes || points > DOCUMENT_LIMITS.strokePoints) {
    return failure("Document stroke limits are exceeded.");
  }
  if (endpoints > DOCUMENT_LIMITS.connectedEndpoints) {
    return failure("Document connected-endpoint limit is exceeded.");
  }
  if ([...fanout.values()].some((count) => count > DOCUMENT_LIMITS.connectedEndpointsPerTarget)) {
    return failure("Document per-target connected-endpoint limit is exceeded.");
  }
  const spatial = measureSpatialCapacity(spatialBounds);
  if (
    spatial.cellMemberships > DOCUMENT_LIMITS.spatialIndexCellMemberships ||
    spatial.overflowElements > DOCUMENT_LIMITS.spatialIndexOverflowElements
  ) {
    return failure("Document spatial-index capacity limits are exceeded.");
  }
  const extent = derivePageExtent(page, maximumBottom);
  if (extent.activeHeight > (DOCUMENT_LIMITS.maximumDerivedHeight ?? Infinity)) {
    return failure("Document maximum derived height is exceeded.");
  }
  return { ok: true, value: undefined };
};

function* documentElements(
  existing: readonly InkElementV1[],
  inserted: readonly InkElementV1[],
  insertedBounds: readonly ElementBounds[] | undefined,
): Generator<readonly [InkElementV1, ElementBounds]> {
  for (const element of existing) yield [element, calculateElementBounds(element)];
  for (let index = 0; index < inserted.length; index += 1) {
    const element = inserted[index]!;
    yield [element, insertedBounds?.[index] ?? calculateElementBounds(element)];
  }
}

const nextRepeat = (
  fingerprint: string,
  previous: PasteRepeatState | undefined,
): { copyIndex: number; state: PasteRepeatState } => {
  const canRepeat =
    previous?.fingerprint === fingerprint &&
    Number.isSafeInteger(previous.pasteCount) &&
    previous.pasteCount > 0;
  const copyIndex = canRepeat ? previous.pasteCount : 0;
  return { copyIndex, state: { fingerprint, pasteCount: copyIndex + 1 } };
};

const validateUntrustedInsertionRecords = (
  elements: readonly InkElementV1[],
): ClipboardResult<void> => {
  for (const element of elements) {
    const validation = validateInkElementV1(element, { limits: FILE_SCHEMA_LIMITS });
    if (!validation.ok) {
      return {
        ok: false,
        error: { code: "invalid-schema", message: validation.error.message },
      };
    }
  }
  return { ok: true, value: undefined };
};

const createIds = (
  clipIds: readonly string[],
  existingIds: ReadonlySet<string>,
  createId: () => string,
): ClipboardResult<Map<string, string>> => {
  const result = new Map<string, string>();
  const generated = new Set<string>();
  for (const clipId of clipIds) {
    const id = createId();
    if (!UUID_V4.test(id) || existingIds.has(id) || generated.has(id)) {
      return {
        ok: false,
        error: {
          code: "invalid-schema",
          message: "The injected ID factory returned an invalid or duplicate UUID v4.",
        },
      };
    }
    generated.add(id);
    result.set(clipId, id);
  }
  return { ok: true, value: result };
};

const hasValidPastePosition = (options: PlanPasteOptions): boolean =>
  Number.isSafeInteger(options.commandTimestamp) &&
  options.commandTimestamp >= 0 &&
  Number.isFinite(options.target.x) &&
  Number.isFinite(options.target.y);

export const planPaste = (options: PlanPasteOptions): ClipboardResult<PastePlan> => {
  if (!hasValidPastePosition(options)) {
    return {
      ok: false,
      error: { code: "invalid-schema", message: "Paste target or timestamp is invalid." },
    };
  }
  const ids = createIds(
    options.decoded.payload.elements.map(({ clipId }) => clipId),
    new Set(options.existingElements.map(({ id }) => id)),
    options.createId,
  );
  if (!ids.ok) return ids;
  const adopted = options.decoded.payload.elements.map(({ clipId, element }) =>
    adoptBody(element, ids.value.get(clipId)!, options.commandTimestamp, ids.value),
  );
  const validatedBounds = getValidatedClipboardBounds(options.decoded.payload);
  const initialBounds =
    validatedBounds === null
      ? unionBounds(adopted, calculateElementBounds)
      : unionElementBounds(validatedBounds);
  const repeat = nextRepeat(options.decoded.fingerprint, options.previousRepeat);
  const repeatedOffset = repeat.copyIndex * REPEATED_PASTE_OFFSET;
  const requestedTranslation = {
    x: round3(options.target.x + repeatedOffset - (initialBounds.minX + initialBounds.maxX) / 2),
    y: round3(options.target.y + repeatedOffset - (initialBounds.minY + initialBounds.maxY) / 2),
  };
  const requested = adopted.map((element) =>
    translateElementGeometry(element, requestedTranslation),
  );
  const requestedBounds =
    validatedBounds === null
      ? unionBounds(requested, calculateElementBounds)
      : translateBounds(initialBounds, requestedTranslation);
  const translated = requested;
  const translatedBounds = validatedBounds?.map((value) =>
    translateBounds(value, requestedTranslation),
  );
  const bounds = requestedBounds;
  if (bounds.maxY > (DOCUMENT_LIMITS.maximumDerivedHeight ?? Infinity)) {
    return failure("Pasted content exceeds the supported document height.");
  }
  if (validatedBounds === null) {
    const records = validateUntrustedInsertionRecords(translated);
    if (!records.ok) return records;
  }
  const documentLimits = countDocumentLimits(
    options.existingElements,
    translated,
    options.page,
    translatedBounds,
  );
  if (!documentLimits.ok) return documentLimits;
  const selectedIds: string[] = [];
  const highlightIds: string[] = [];
  const contentIds: string[] = [];
  for (const element of translated) {
    selectedIds.push(element.id);
    if (
      element.kind === "straight-highlighter" ||
      (element.kind === "stroke" && element.tool === "highlighter")
    ) {
      highlightIds.push(element.id);
    } else {
      contentIds.push(element.id);
    }
  }
  return {
    ok: true,
    value: {
      elements: translated,
      selectedIds,
      highlightIds,
      contentIds,
      insertAtBandFront: true,
      activateTool: "select",
      commandTimestamp: options.commandTimestamp,
      translation: requestedTranslation,
      repeatState: repeat.state,
    },
  };
};

const sameIdentity = (
  left: ClipboardOperationIdentity,
  right: ClipboardOperationIdentity,
): boolean =>
  left.sessionId === right.sessionId &&
  left.workerEpoch === right.workerEpoch &&
  left.clipboardOperationId === right.clipboardOperationId &&
  left.basisRevision === right.basisRevision;

const sameSelection = (
  left: readonly VersionedSelectionRecord[],
  right: readonly VersionedSelectionRecord[],
): boolean => {
  if (left.length !== right.length) return false;
  const current = new Map(right.map((record) => [record.id, record]));
  return left.every((record) => {
    const candidate = current.get(record.id);
    return (
      candidate !== undefined &&
      candidate.geometryVersion === record.geometryVersion &&
      candidate.paintVersion === record.paintVersion
    );
  });
};

export const isCurrentPasteResult = (
  resultIdentity: ClipboardOperationIdentity,
  current: ClipboardOperationIdentity,
): boolean => sameIdentity(resultIdentity, current);

export const classifyPasteResult = (
  resultIdentity: ClipboardOperationIdentity,
  current: ClipboardOperationIdentity,
  userActionPending: boolean,
): "adopt" | "recompute" | "discard" => {
  if (sameIdentity(resultIdentity, current)) return "adopt";
  return userActionPending ? "recompute" : "discard";
};

export const validatePasteAdoption = (
  options: ValidatePasteAdoptionOptions,
): ClipboardResult<void> => {
  if (!sameIdentity(options.resultIdentity, options.current)) {
    return {
      ok: false,
      error: {
        code: "stale-operation",
        message: "Paste result no longer matches the active document revision.",
      },
    };
  }
  const currentIds = new Set(options.currentElements.map(({ id }) => id));
  if (options.plan.elements.some(({ id }) => currentIds.has(id))) {
    return {
      ok: false,
      error: {
        code: "invalid-schema",
        message: "Paste result collides with a current document ID.",
      },
    };
  }
  return countDocumentLimits(options.currentElements, options.plan.elements, options.page);
};

export const isCurrentCut = (guard: CutGuard, current: CurrentClipboardState): boolean =>
  current.presentationAttached &&
  sameIdentity(guard, current) &&
  sameSelection(guard.selectedRecords, current.selectedRecords);
