import { createHash } from "node:crypto";

import { parseSha256Digest } from "../../../src/application/note-session";
import type {
  CommandResultV1,
  Sha256Digest,
} from "../../../src/application/note-session";
import type {
  StreamingSha256PortV1,
  StreamingSha256SinkV1,
  SourceOffsetMapV1,
} from "../../../src/application/source-coordination/types";
import { composeSourceMapCompositionRequest } from "../../../src/application/source-coordination/map-graph";
import type {
  SourceCheckpointSchedulerV1,
  SourceCheckpointTimerHandleV1,
} from "../../../src/application/source-coordination/checkpoints";
import type {
  NormalizedSourceMapCompositionRequestV1,
  SourceDigestWorkPortV1,
  SourceDigestWorkSubmissionV1,
  SourceMapWorkPortV1,
  SourceMapWorkSubmissionV1,
} from "../../../src/application/source-coordination/work-ports";

const MAXIMUM_MICROTASK_FLUSHES = 32;

export class TestStreamingDigestPort implements StreamingSha256PortV1 {
  readonly chunkSizes: number[] = [];

  create(): StreamingSha256SinkV1 {
    const hash = createHash("sha256");
    return {
      finish: async () => parseSha256Digest(hash.digest("hex")),
      update: (chunk): void => {
        this.chunkSizes.push(chunk.byteLength);
        hash.update(chunk);
      },
    };
  }
}

export function digestUtf8(
  value: string,
): ReturnType<typeof parseSha256Digest> {
  return parseSha256Digest(createHash("sha256").update(value).digest("hex"));
}

export class ImmediateSourceMapWorkPort implements SourceMapWorkPortV1 {
  readonly requests: NormalizedSourceMapCompositionRequestV1[] = [];

  submit(
    request: NormalizedSourceMapCompositionRequestV1,
  ): SourceMapWorkSubmissionV1 {
    this.requests.push(request);
    return {
      cancel: (): void => undefined,
      completion: Promise.resolve(composeSourceMapCompositionRequest(request)),
    };
  }
}

export class ImmediateSourceDigestWorkPort implements SourceDigestWorkPortV1 {
  readonly chunkSizes: number[] = [];
  submissions = 0;

  submit(): SourceDigestWorkSubmissionV1 {
    this.submissions += 1;
    const hash = createHash("sha256");
    let resolve!: (result: CommandResultV1<Sha256Digest>) => void;
    const completion = new Promise<CommandResultV1<Sha256Digest>>(
      (complete) => {
        resolve = complete;
      },
    );
    let closed = false;
    return {
      cancel: (): void => {
        closed = true;
      },
      closeInput: (): void => {
        if (closed) return;
        closed = true;
        resolve({ ok: true, value: parseSha256Digest(hash.digest("hex")) });
      },
      completion,
      update: (chunk): void => {
        if (closed) throw new Error("Digest work is closed.");
        this.chunkSizes.push(chunk.byteLength);
        hash.update(chunk);
      },
    };
  }
}

export interface PendingSourceMapWork {
  cancelled: boolean;
  readonly completion: Promise<CommandResultV1<SourceOffsetMapV1>>;
  readonly reject: (error: unknown) => void;
  readonly request: NormalizedSourceMapCompositionRequestV1;
  readonly resolve: (result: CommandResultV1<SourceOffsetMapV1>) => void;
}

export class ControlledSourceMapWorkPort implements SourceMapWorkPortV1 {
  readonly pending: PendingSourceMapWork[] = [];

  submit(
    request: NormalizedSourceMapCompositionRequestV1,
  ): SourceMapWorkSubmissionV1 {
    let reject!: (error: unknown) => void;
    let resolve!: (result: CommandResultV1<SourceOffsetMapV1>) => void;
    const completion = new Promise<CommandResultV1<SourceOffsetMapV1>>(
      (complete, fail) => {
        resolve = complete;
        reject = fail;
      },
    );
    const pending = { cancelled: false, completion, reject, request, resolve };
    this.pending.push(pending);
    return {
      cancel: (): void => {
        pending.cancelled = true;
      },
      completion,
    };
  }

  complete(index: number): void {
    const pending = this.pending[index];
    if (pending === undefined) throw new Error("Missing source-map work.");
    pending.resolve(composeSourceMapCompositionRequest(pending.request));
  }
}

interface ScheduledSourceTask {
  readonly callback: () => void;
  readonly due: number;
  cancelled: boolean;
}

export class ControlledSourceScheduler implements SourceCheckpointSchedulerV1 {
  readonly #tasks: ScheduledSourceTask[] = [];
  #now = 0;

  cancel(handle: SourceCheckpointTimerHandleV1): void {
    if (typeof handle === "object" && "cancelled" in handle) {
      (handle as ScheduledSourceTask).cancelled = true;
    }
  }

  now(): number {
    return this.#now;
  }

  schedule(delayMs: number, callback: () => void): ScheduledSourceTask {
    const task = { callback, due: this.#now + delayMs, cancelled: false };
    this.#tasks.push(task);
    return task;
  }

  advance(milliseconds: number): void {
    this.#now += milliseconds;
    for (const task of this.#tasks) {
      if (!task.cancelled && task.due <= this.#now) {
        task.cancelled = true;
        task.callback();
      }
    }
  }
}

export async function flushSourceMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

export async function flushSourceUntil(
  predicate: () => boolean,
): Promise<void> {
  for (let index = 0; index < MAXIMUM_MICROTASK_FLUSHES; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Expected microtask work did not become observable.");
}
