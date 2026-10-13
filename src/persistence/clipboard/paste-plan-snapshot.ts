import {
  CLIPBOARD_SCHEMA_LIMITS,
  type InkElementV1,
  type PointV1,
} from "../../domain/schema/public";
import type { PastePlan, PasteRepeatState } from "./types";

const capturedPlans = new WeakSet<PastePlan>();

function ownValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor))
    throw new TypeError("Paste plan fields must be own data properties.");
  return descriptor.value as unknown;
}

function boundedArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > CLIPBOARD_SCHEMA_LIMITS.elements)
    throw new RangeError("Paste plan array exceeds the element limit.");
  const captured: unknown[] = [];
  for (let index = 0; index < value.length; index += 1)
    captured.push(ownValue(value, String(index)));
  return captured;
}

function captureIds(value: unknown): readonly string[] {
  const ids = boundedArray(value);
  if (!ids.every((id): id is string => typeof id === "string"))
    throw new TypeError("Paste plan IDs must be strings.");
  return Object.freeze(ids);
}

function capturePoint(value: unknown): PointV1 {
  if (value === null || typeof value !== "object")
    throw new TypeError("Paste translation must be a point.");
  const x = ownValue(value, "x");
  const y = ownValue(value, "y");
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y))
    throw new TypeError("Paste translation must be finite.");
  return Object.freeze({ x, y });
}

function captureRepeat(value: unknown): PasteRepeatState {
  if (value === null || typeof value !== "object") throw new TypeError("Invalid paste repetition.");
  const fingerprint = ownValue(value, "fingerprint");
  const pasteCount = ownValue(value, "pasteCount");
  if (
    typeof fingerprint !== "string" ||
    typeof pasteCount !== "number" ||
    !Number.isSafeInteger(pasteCount) ||
    pasteCount < 1
  )
    throw new TypeError("Invalid paste repetition.");
  return Object.freeze({ fingerprint, pasteCount });
}

function captureTimestamp(plan: PastePlan): number {
  const timestamp = ownValue(plan, "commandTimestamp");
  if (
    typeof timestamp !== "number" ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    ownValue(plan, "activateTool") !== "select" ||
    ownValue(plan, "insertAtBandFront") !== true
  )
    throw new TypeError("Invalid paste command.");
  return timestamp;
}

/** Capture the plan wrapper before any scheduler or Store-preparation suspension. */
export function capturePastePlan(plan: PastePlan): PastePlan | null {
  if (capturedPlans.has(plan)) return plan;
  try {
    const elements = boundedArray(ownValue(plan, "elements"));
    if (
      !elements.every(
        (element) => element !== null && typeof element === "object" && !Array.isArray(element),
      )
    )
      return null;
    const captured: PastePlan = Object.freeze({
      elements: Object.freeze(elements as InkElementV1[]),
      selectedIds: captureIds(ownValue(plan, "selectedIds")),
      contentIds: captureIds(ownValue(plan, "contentIds")),
      highlightIds: captureIds(ownValue(plan, "highlightIds")),
      translation: capturePoint(ownValue(plan, "translation")),
      repeatState: captureRepeat(ownValue(plan, "repeatState")),
      commandTimestamp: captureTimestamp(plan),
      activateTool: "select",
      insertAtBandFront: true,
    });
    capturedPlans.add(captured);
    return captured;
  } catch {
    return null;
  }
}
