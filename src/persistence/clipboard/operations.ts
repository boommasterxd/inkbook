import type {
  ClipboardElementBodyV1,
  EndpointConnectionV1,
  InkElementV1,
  PageV1,
  PointV1,
} from "../../domain/schema/public";
import { FILE_SCHEMA_LIMITS } from "../../domain/schema/public";
import { validateInkElementV1Steps } from "../../domain/schema/element-validation";
import { calculateElementBoundsSteps } from "../../domain/geometry/bounds";
import { translateElementGeometry } from "../../domain/geometry/public";
import {
  completeSerializationSteps,
  consumeSerializationSteps,
} from "../serialization/output/serialization-model-preparation";
import { countDocumentLimitsSteps, countValidatedDocumentLimitsSteps } from "./paste-plan-capacity";
import type { AggregateFacts } from "../serialization/output/incremental-validation";
import { DOCUMENT_LIMITS, REPEATED_PASTE_OFFSET } from "./constants";
import type {
  ClipboardResult,
  ClipboardShortcutAction,
  ClipboardShortcutContext,
  DecodedClipboard,
  ElementBounds,
  PastePlan,
  PasteInvocation,
  PasteRepeatState,
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

export interface ValidatedModelPasteOptions extends Omit<PlanPasteOptions, "existingElements"> {
  validatedModel: {
    readonly facts: Readonly<AggregateFacts>;
    readonly hasExistingId: (id: string) => boolean;
  };
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

function* unionBoundsSteps(
  elements: readonly InkElementV1[],
  validated?: readonly ElementBounds[] | null,
): Generator<void, ElementBounds> {
  let bounds = validated?.[0] ?? (yield* calculateElementBoundsSteps(elements[0]!));
  for (let index = 1; index < elements.length; index += 1) {
    const next = validated?.[index] ?? (yield* calculateElementBoundsSteps(elements[index]!));
    bounds = {
      minX: Math.min(bounds.minX, next.minX),
      minY: Math.min(bounds.minY, next.minY),
      maxX: Math.max(bounds.maxX, next.maxX),
      maxY: Math.max(bounds.maxY, next.maxY),
    };
    yield;
  }
  return bounds;
}

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

function* validateUntrustedInsertionRecordsSteps(
  elements: readonly InkElementV1[],
): Generator<boolean | void, ClipboardResult<void>> {
  for (const element of elements) {
    const validation = yield* validateInkElementV1Steps(
      element,
      { limits: FILE_SCHEMA_LIMITS },
      256,
      256,
    );
    if (!validation.ok) {
      return {
        ok: false,
        error: { code: "invalid-schema", message: validation.error.message },
      };
    }
    yield;
  }
  return { ok: true, value: undefined };
}

function* createIdsSteps(
  elements: DecodedClipboard["payload"]["elements"],
  hasExistingId: (id: string) => boolean,
  createId: () => string,
): Generator<void, ClipboardResult<Map<string, string>>> {
  const result = new Map<string, string>();
  const generated = new Set<string>();
  for (const { clipId } of elements) {
    const id = createId();
    if (!UUID_V4.test(id) || hasExistingId(id) || generated.has(id)) {
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
    yield;
  }
  return { ok: true, value: result };
}

const hasValidPastePosition = (options: Omit<PlanPasteOptions, "existingElements">): boolean =>
  Number.isSafeInteger(options.commandTimestamp) &&
  options.commandTimestamp >= 0 &&
  Number.isFinite(options.target.x) &&
  Number.isFinite(options.target.y);

export function planPaste(
  options: PlanPasteOptions | ValidatedModelPasteOptions,
): ClipboardResult<PastePlan> {
  return completeSerializationSteps(planPasteSteps(options));
}

export async function planPasteSliced(
  options: PlanPasteOptions | ValidatedModelPasteOptions,
  context: { readonly signal: AbortSignal; checkpoint(): Promise<void> | undefined },
  assertCurrent: () => void,
): Promise<ClipboardResult<PastePlan>> {
  const assertLive = (): void => {
    context.signal.throwIfAborted();
    assertCurrent();
  };
  const checkpoint = (): Promise<void> | undefined => {
    assertLive();
    return context.checkpoint()?.then(assertLive);
  };
  const admission = checkpoint();
  if (admission !== undefined) await admission;
  const result = await consumeSerializationSteps(planPasteSteps(options), {
    checkpoint,
    signal: context.signal,
  });
  assertLive();
  return result;
}

/** All yield markers consult central admission; an unspent budget continues synchronously. */
function* planPasteSteps(
  options: PlanPasteOptions | ValidatedModelPasteOptions,
): Generator<boolean | void, ClipboardResult<PastePlan>> {
  if ("validatedModel" in options) {
    const { facts, hasExistingId } = options.validatedModel;
    return yield* planPasteInternalSteps(options, hasExistingId, null, facts);
  }
  const existingIds = new Set<string>();
  for (const { id } of options.existingElements) {
    existingIds.add(id);
    yield;
  }
  return yield* planPasteInternalSteps(
    options,
    (id) => existingIds.has(id),
    options.existingElements,
  );
}

function* planPasteInternalSteps(
  options: Omit<PlanPasteOptions, "existingElements">,
  hasExistingId: (id: string) => boolean,
  existingElements: readonly InkElementV1[] | null,
  existingFacts?: Readonly<AggregateFacts>,
): Generator<boolean | void, ClipboardResult<PastePlan>> {
  if (!hasValidPastePosition(options)) {
    return {
      ok: false,
      error: { code: "invalid-schema", message: "Paste target or timestamp is invalid." },
    };
  }
  const ids = yield* createIdsSteps(
    options.decoded.payload.elements,
    hasExistingId,
    options.createId,
  );
  if (!ids.ok) return ids;
  const adopted: InkElementV1[] = [];
  for (const { clipId, element } of options.decoded.payload.elements) {
    adopted.push(adoptBody(element, ids.value.get(clipId)!, options.commandTimestamp, ids.value));
    yield;
  }
  const validatedBounds = getValidatedClipboardBounds(options.decoded.payload);
  const initialBounds = yield* unionBoundsSteps(adopted, validatedBounds);
  const repeat = nextRepeat(options.decoded.fingerprint, options.previousRepeat);
  const repeatedOffset = repeat.copyIndex * REPEATED_PASTE_OFFSET;
  const requestedTranslation = {
    x: round3(options.target.x + repeatedOffset - (initialBounds.minX + initialBounds.maxX) / 2),
    y: round3(options.target.y + repeatedOffset - (initialBounds.minY + initialBounds.maxY) / 2),
  };
  const requested: InkElementV1[] = [];
  for (const element of adopted) {
    requested.push(translateElementGeometry(element, requestedTranslation));
    yield;
  }
  const requestedBounds =
    validatedBounds === null
      ? yield* unionBoundsSteps(requested)
      : translateBounds(initialBounds, requestedTranslation);
  const translated = requested;
  const translatedBounds = validatedBounds === null ? undefined : ([] as ElementBounds[]);
  if (validatedBounds !== null) {
    for (const value of validatedBounds) {
      translatedBounds!.push(translateBounds(value, requestedTranslation));
      yield;
    }
  }
  const bounds = requestedBounds;
  if (bounds.maxY > (DOCUMENT_LIMITS.maximumDerivedHeight ?? Infinity)) {
    return failure("Pasted content exceeds the supported document height.");
  }
  if (validatedBounds === null) {
    const records = yield* validateUntrustedInsertionRecordsSteps(translated);
    if (!records.ok) return records;
  }
  if (existingFacts === undefined && existingElements === null) {
    throw new Error("Paste requires existing elements or validated aggregate facts.");
  }
  const documentLimits =
    existingFacts === undefined
      ? yield* countDocumentLimitsSteps(
          existingElements!,
          translated,
          options.page,
          translatedBounds,
        )
      : yield* countValidatedDocumentLimitsSteps(
          existingFacts,
          translated,
          options.page,
          translatedBounds,
        );
  if (!documentLimits.ok) return documentLimits;
  const grouped = yield* groupPlannedElementsSteps(translated);
  return {
    ok: true,
    value: {
      ...grouped,
      elements: translated,
      insertAtBandFront: true,
      activateTool: "select",
      commandTimestamp: options.commandTimestamp,
      translation: requestedTranslation,
      repeatState: repeat.state,
    },
  };
}

function* groupPlannedElementsSteps(
  translated: readonly InkElementV1[],
): Generator<void, Pick<PastePlan, "selectedIds" | "highlightIds" | "contentIds">> {
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
    yield;
  }
  return { selectedIds, highlightIds, contentIds };
}
