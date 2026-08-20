import {
  MAX_WORKER_TASK_INPUT_BYTES,
  MAX_WORKER_DECODED_OUTPUT_BYTES,
  MAX_WORKER_TASK_OUTPUT_BYTES,
  MAX_WORKER_TASK_SCRATCH_BYTES,
  type WorkerWorkKind,
} from "./protocol";

const SHA256_BYTES = 32;
const SOURCE_MAP_BYTES = 4_194_304;
const SHA256_SCRATCH_BYTES = 262_144;

interface WorkerWorkProfile {
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxScratchBytes: number;
  readonly exactOutputBytes?: number;
}

const WORK_PROFILES: Readonly<Record<WorkerWorkKind, WorkerWorkProfile>> = {
  "byte-process": {
    maxInputBytes: MAX_WORKER_TASK_INPUT_BYTES,
    maxOutputBytes: MAX_WORKER_TASK_OUTPUT_BYTES,
    maxScratchBytes: MAX_WORKER_TASK_SCRATCH_BYTES,
  },
  "source-digest": {
    maxInputBytes: MAX_WORKER_TASK_INPUT_BYTES,
    maxOutputBytes: SHA256_BYTES,
    maxScratchBytes: SHA256_SCRATCH_BYTES,
    exactOutputBytes: SHA256_BYTES,
  },
  "source-map-compose": {
    maxInputBytes: SOURCE_MAP_BYTES,
    maxOutputBytes: SOURCE_MAP_BYTES,
    maxScratchBytes: MAX_WORKER_TASK_SCRATCH_BYTES,
  },
  "source-map-compact": {
    maxInputBytes: SOURCE_MAP_BYTES,
    maxOutputBytes: SOURCE_MAP_BYTES,
    maxScratchBytes: MAX_WORKER_TASK_SCRATCH_BYTES,
  },
  "persistence-encode": {
    maxInputBytes: MAX_WORKER_TASK_INPUT_BYTES,
    maxOutputBytes: MAX_WORKER_TASK_OUTPUT_BYTES,
    maxScratchBytes: MAX_WORKER_TASK_SCRATCH_BYTES,
  },
  "persistence-parse": {
    maxInputBytes: MAX_WORKER_TASK_INPUT_BYTES,
    maxOutputBytes: MAX_WORKER_DECODED_OUTPUT_BYTES,
    maxScratchBytes: MAX_WORKER_TASK_SCRATCH_BYTES,
  },
};

export interface WorkerWorkBounds {
  readonly maxOutputBytes: number;
  readonly scratchBytes: number;
}

export function assertWorkerWorkBounds(
  workKind: Exclude<WorkerWorkKind, "byte-process">,
  inputBytes: number,
  bounds: WorkerWorkBounds,
): void {
  const profile = WORK_PROFILES[workKind];
  assertBound("inputBytes", inputBytes, profile.maxInputBytes, true);
  assertBound(
    "maxOutputBytes",
    bounds.maxOutputBytes,
    profile.maxOutputBytes,
    false,
  );
  assertBound(
    "scratchBytes",
    bounds.scratchBytes,
    profile.maxScratchBytes,
    true,
  );
  if (
    profile.exactOutputBytes !== undefined &&
    bounds.maxOutputBytes !== profile.exactOutputBytes
  ) {
    throw new RangeError(
      `${workKind} output must reserve exactly ${String(profile.exactOutputBytes)} bytes.`,
    );
  }
}

export function isValidWorkerOutputLength(
  workKind: WorkerWorkKind,
  outputBytes: number,
  maxOutputBytes: number,
): boolean {
  const exactOutputBytes = WORK_PROFILES[workKind].exactOutputBytes;
  return (
    Number.isSafeInteger(outputBytes) &&
    outputBytes >= 0 &&
    outputBytes <= maxOutputBytes &&
    (exactOutputBytes === undefined || outputBytes === exactOutputBytes)
  );
}

export function assertPositiveCapacityLimit(
  name: string,
  value: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(
      `${name} must be a positive safe integer at most ${String(maximum)}.`,
    );
  }
}

function assertBound(
  name: string,
  value: number,
  maximum: number,
  allowZero: boolean,
): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be a safe integer from ${String(minimum)} through ${String(maximum)}.`,
    );
  }
}
