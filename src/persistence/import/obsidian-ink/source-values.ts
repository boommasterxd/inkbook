export type SourceRecord = Record<string, unknown>;

export interface ImportOptions {
  readonly checkpoint: () => Promise<void> | undefined;
  readonly signal: AbortSignal;
  readonly timestamp: number;
  readonly legacyWriting?: boolean;
}

export class ObsidianInkImportError extends Error {
  public constructor(
    public readonly code: "invalid-source" | "unsupported-content" | "capacity-exceeded",
    message: string,
  ) {
    super(message);
    this.name = "ObsidianInkImportError";
  }
}

export function invalid(message: string): never {
  throw new ObsidianInkImportError("invalid-source", message);
}

export function unsupported(message: string): never {
  throw new ObsidianInkImportError("unsupported-content", message);
}

export function record(value: unknown, label: string): SourceRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label}: expected an object.`);
  }
  return value as SourceRecord;
}

export function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${label}: expected an array.`);
  return value;
}

export function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(`${label}: expected a finite number.`);
  }
  return value;
}

export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    invalid(`${label}: expected bounded, nonempty text.`);
  }
  return value;
}

export function optionalNumber(value: unknown, fallback: number, label: string): number {
  return value === undefined ? fallback : finite(value, label);
}

export function unit(value: unknown, fallback: number): number {
  const number = optionalNumber(value, fallback, "Opacity");
  if (number < 0 || number > 1) invalid("Opacity or pressure lies outside [0, 1].");
  return number;
}

export function point(value: unknown): { x: number; y: number } {
  const source = record(value, "Point");
  return { x: finite(source.x, "Point x"), y: finite(source.y, "Point y") };
}

export function rotation(value: unknown): number {
  const degrees = optionalNumber(value, 0, "Rotation");
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

export function targetId(index: number): string {
  return `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`;
}

export function checkpoint(options: ImportOptions): Promise<void> | undefined {
  options.signal.throwIfAborted();
  return options.checkpoint();
}

export async function completeSteps<T>(
  steps: Generator<void, T>,
  options: ImportOptions,
): Promise<T> {
  let step = steps.next();
  while (!step.done) {
    const pending = checkpoint(options);
    if (pending !== undefined) await pending;
    options.signal.throwIfAborted();
    step = steps.next();
  }
  options.signal.throwIfAborted();
  return step.value;
}
