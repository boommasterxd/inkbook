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
  if (event.type === "visibilitychange") {
    record["hidden"] = (event.target as Document).hidden;
  }
  return record as PenDiagnosticRecord;
}
