import {
  createSourceMapFallbackWorkV1,
  validateAndNormalizeSourceMapCompositionRequestV1,
} from "../application/source-coordination/map-composition-fallback";
import {
  encodedSourceOffsetMapBytes,
  validateSourceOffsetMap,
} from "../application/source-coordination/offset-map";
import type {
  CommandErrorCodeV1,
  CommandResultV1,
} from "../application/note-session/types";
import type { SourceOffsetMapV1 } from "../application/source-coordination/types";
import type {
  NormalizedSourceMapCompositionRequestV1,
  SourceMapWorkPortV1,
  SourceMapWorkSubmissionV1,
} from "../application/source-coordination/work-ports";
import type { WorkerRevision } from "./scheduler/protocol";
import type {
  StructuredWorkerSubmission,
  WorkerFallbackProcessor,
} from "./scheduler/scheduler-types";
import { ByteWorkerScheduler } from "./scheduler/scheduler";

const MAX_ENCODED_MAP_BYTES = 4_194_304;

export class SchedulerSourceMapWorkPortV1 implements SourceMapWorkPortV1 {
  constructor(
    private readonly scheduler: ByteWorkerScheduler,
    private readonly readRevision: () => WorkerRevision,
  ) {}

  submit(
    request: NormalizedSourceMapCompositionRequestV1,
  ): SourceMapWorkSubmissionV1 {
    const normalized =
      validateAndNormalizeSourceMapCompositionRequestV1(request);
    if (!normalized.ok) throw new TypeError("Source map work is invalid.");
    const workerSubmission = this.scheduler.submitStructured({
      kind: "source-map-compose",
      payload: normalized.value,
      inputBytes: compositionInputBytes(normalized.value),
      revision: this.readRevision(),
      priority: "background",
      mode: "idle",
      maxOutputBytes: MAX_ENCODED_MAP_BYTES,
      scratchBytes: normalized.value.scratchByteLimit,
      createFallbackProcessor: () => createMapProcessor(normalized.value),
      normalizeResult: (value) => normalizeMapResult(value, normalized.value),
    });
    return mapSubmission(workerSubmission);
  }
}

function createMapProcessor(
  request: NormalizedSourceMapCompositionRequestV1,
): WorkerFallbackProcessor<CommandResultV1<SourceOffsetMapV1>> {
  const work = createSourceMapFallbackWorkV1(request);
  let result: CommandResultV1<SourceOffsetMapV1> | undefined;
  return {
    processNext(): boolean {
      let unit = 0;
      const progress = work.resume({ shouldYield: () => unit++ > 0 });
      if (!progress.ok) {
        result = progress;
        return true;
      }
      if (progress.value.kind === "pending") return false;
      result = Object.freeze({ ok: true, value: progress.value.offsetMap });
      return true;
    },
    complete(): CommandResultV1<SourceOffsetMapV1> {
      if (result === undefined)
        throw new Error("Source map work is incomplete.");
      return result;
    },
    dispose(): void {
      work.cancel();
      result = undefined;
    },
  };
}

function normalizeMapResult(
  value: unknown,
  request: NormalizedSourceMapCompositionRequestV1,
): CommandResultV1<SourceOffsetMapV1> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Source map result must be a record.");
  }
  const result = value as { ok?: unknown; value?: unknown; code?: unknown };
  if (result.ok === true) {
    const normalized = validateSourceOffsetMap(
      result.value,
      request.priorUtf16Length,
      request.replacementUtf16Length,
    );
    if (!normalized.ok) throw new TypeError("Source map result is invalid.");
    return Object.freeze({ ok: true, value: normalized.value });
  }
  if (result.ok !== false || !isCommandErrorCode(result.code)) {
    throw new TypeError("Source map failure is invalid.");
  }
  return Object.freeze({ ok: false, code: result.code });
}

function compositionInputBytes(
  request: NormalizedSourceMapCompositionRequestV1,
): number {
  return request.segments.reduce(
    (total, segment) =>
      total +
      encodedSourceOffsetMapBytes(
        segment.offsetMap,
        segment.priorUtf16Length,
        segment.replacementUtf16Length,
      ),
    0,
  );
}

function mapSubmission(
  submission: StructuredWorkerSubmission<CommandResultV1<SourceOffsetMapV1>>,
): SourceMapWorkSubmissionV1 {
  return Object.freeze({
    completion: submission.result,
    cancel: (): void => submission.cancel(),
  });
}

function isCommandErrorCode(value: unknown): value is CommandErrorCodeV1 {
  return (
    typeof value === "string" &&
    COMMAND_ERROR_CODES.has(value as CommandErrorCodeV1)
  );
}

const COMMAND_ERROR_CODES = new Set<CommandErrorCodeV1>([
  "invalid-command",
  "stale-scene",
  "stale-source",
  "stale-layout",
  "history-unavailable",
  "history-lease-unavailable",
  "recovery-unavailable",
  "recovery-limit",
  "resource-limit",
  "read-only-mode",
  "sidecar-drift",
  "sidecar-conflict",
  "relocation-pending",
  "disposed",
]);
