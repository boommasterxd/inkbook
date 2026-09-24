/** Allowlisted input telemetry, deliberately excluding DOM content and identifiers. */
export interface PenDiagnosticRecord {
  readonly relativeTimeMs: number;
  readonly windowId: number;
  readonly type: string;
  readonly [key: string]: string | number | boolean | readonly PenDiagnosticSample[];
}

interface PenDiagnosticSample {
  readonly [key: string]: number;
}

const numericFields = [
  "timeStamp",
  "pointerId",
  "button",
  "buttons",
  "pressure",
  "tangentialPressure",
  "tiltX",
  "tiltY",
  "twist",
  "width",
  "height",
  "clientX",
  "clientY",
  "detail",
] as const;
const booleanFields = [
  "isPrimary",
  "isTrusted",
  "cancelable",
  "defaultPrevented",
  "altKey",
  "ctrlKey",
  "metaKey",
  "shiftKey",
] as const;

function numericSample(event: object, fields: readonly string[]): PenDiagnosticSample {
  const source = event as Record<string, unknown>;
  const sample: Record<string, number> = {};
  for (const field of fields) {
    const value = source[field];
    if (typeof value === "number" && Number.isFinite(value)) sample[field] = value;
  }
  return sample;
}

function withinInkbook(event: Event): boolean {
  return event
    .composedPath()
    .slice(0, 64)
    .some((target) => {
      const element = target as Partial<Element>;
      return (
        element.classList?.contains("inkbook-canvas-input") === true ||
        element.classList?.contains("inkbook-embed-root") === true
      );
    });
}

function addPointerDetails(record: Record<string, unknown>, event: PointerEvent): void {
  record["pointerType"] = ["pen", "touch", "mouse", ""].includes(event.pointerType)
    ? event.pointerType
    : "other";
  const target = event.target as Partial<Element> | null;
  if (typeof target?.hasPointerCapture === "function") {
    record["hasPointerCapture"] = target.hasPointerCapture(event.pointerId);
  }
  if (typeof event.getCoalescedEvents !== "function") return;
  const coalesced = event.getCoalescedEvents();
  record["coalescedCount"] = coalesced.length;
  record["coalescedSamples"] = coalesced
    .slice(0, 4)
    .map((sample) =>
      numericSample(sample, ["timeStamp", "clientX", "clientY", "pressure", "buttons"]),
    );
}

function addTouchDetails(record: Record<string, unknown>, event: TouchEvent): void {
  record["touchCount"] = event.touches.length;
  record["targetTouchCount"] = event.targetTouches.length;
  record["changedTouchCount"] = event.changedTouches.length;
  const samples: PenDiagnosticSample[] = [];
  for (let index = 0; index < Math.min(event.changedTouches.length, 2); index += 1) {
    const touch = event.changedTouches[index];
    if (touch)
      samples.push(
        numericSample(touch, [
          "identifier",
          "clientX",
          "clientY",
          "force",
          "radiusX",
          "radiusY",
          "rotationAngle",
        ]),
      );
  }
  record["changedTouches"] = samples;
}

const nonTextKeys = new Set([
  "",
  "Unidentified",
  "ContextMenu",
  "Escape",
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Pause",
  "PrintScreen",
  "Clear",
  "Cancel",
  "Help",
]);

function nonTextKey(value: string): boolean {
  return (
    nonTextKeys.has(value) ||
    /^(?:F(?:[1-9]|1[0-9]|2[0-4])|(?:Shift|Control|Alt|Meta)(?:Left|Right)|StylusButton(?:Primary|Secondary|Tertiary|Tail))$/.test(
      value,
    )
  );
}

function addKeyboardDetails(record: Record<string, unknown>, event: KeyboardEvent): void {
  const safeKey = nonTextKey(event.key);
  const safeCode = nonTextKey(event.code);
  record["key"] = safeKey ? event.key : "[redacted]";
  record["code"] = safeCode ? event.code : "[redacted]";
  record["repeat"] = event.repeat;
  record["isComposing"] = event.isComposing;
  Object.assign(record, numericSample(event, ["location"]));
  // Keep browser-reported legacy codes for unidentified/control events only.
  // They are evidence, not Android native keycodes or an eraser classification.
  if (safeKey && safeCode && !event.isComposing) {
    Object.assign(record, numericSample(event, ["keyCode", "which"]));
  }
}

export function recordPenEvent(
  event: Event,
  windowId: number,
  relativeTimeMs: number,
): PenDiagnosticRecord {
  const record: Record<string, unknown> = {
    relativeTimeMs,
    windowId,
    type: event.type,
    ...numericSample(event, numericFields),
    targetWithinInkbook: withinInkbook(event),
  };
  const source = event as unknown as Record<string, unknown>;
  for (const field of booleanFields) {
    if (typeof source[field] === "boolean") record[field] = source[field];
  }
  if ("pointerId" in event) addPointerDetails(record, event as PointerEvent);
  if ("changedTouches" in event) addTouchDetails(record, event as TouchEvent);
  if (event.type === "keydown" || event.type === "keyup")
    addKeyboardDetails(record, event as KeyboardEvent);
  if (event.type === "visibilitychange") {
    record["hidden"] = (event.target as Document).hidden;
  }
  return record as PenDiagnosticRecord;
}
