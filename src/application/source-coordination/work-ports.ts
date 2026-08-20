import { commandFailure } from "../note-session/results";
import type { CommandResultV1, Sha256Digest } from "../note-session/types";
import type { SourceOffsetMapV1 } from "./types";
import type { HistoryMaterializationWorkV1 } from "./history-materialization";

export interface SourceMapCompositionSegmentV1 {
  readonly offsetMap: SourceOffsetMapV1;
  readonly priorUtf16Length: number;
  readonly replacementUtf16Length: number;
}

export interface SourceMapCompositionRequestV1 {
  readonly priorUtf16Length: number;
  readonly replacementUtf16Length: number;
  readonly scratchByteLimit: number;
  readonly segments: readonly SourceMapCompositionSegmentV1[];
  readonly wireVersion: 1;
}

declare const NORMALIZED_SOURCE_MAP_WORK: unique symbol;
export type NormalizedSourceMapCompositionRequestV1 =
  SourceMapCompositionRequestV1 & {
    readonly [NORMALIZED_SOURCE_MAP_WORK]: true;
  };

export interface SourceMapWorkSubmissionV1 {
  readonly completion: Promise<CommandResultV1<SourceOffsetMapV1>>;
  cancel(): void;
}

export interface SourceMapWorkPortV1 {
  submit(
    request: NormalizedSourceMapCompositionRequestV1,
  ): SourceMapWorkSubmissionV1;
}

export interface SourceDigestWorkSubmissionV1 {
  readonly completion: Promise<CommandResultV1<Sha256Digest>>;
  cancel(): void;
  closeInput(): void;
  update(chunk: Uint8Array): void | Promise<void>;
}

export interface SourceDigestWorkPortV1 {
  submit(): SourceDigestWorkSubmissionV1;
}

interface HistoryMaterializationWorkSubmissionV1<R> {
  readonly completion: Promise<CommandResultV1<R>>;
  cancel(): void;
}

export interface HistoryMaterializationWorkPortV1<T, R> {
  submit(
    work: HistoryMaterializationWorkV1<T>,
  ): HistoryMaterializationWorkSubmissionV1<R>;
}

export interface SourceMapSliceBudgetV1 {
  shouldYield(): boolean;
}

export type SourceMapFallbackSliceResultV1 =
  | { readonly kind: "pending" }
  | { readonly kind: "completed"; readonly offsetMap: SourceOffsetMapV1 };

export interface SourceMapFallbackWorkV1 {
  cancel(): void;
  resume(
    budget: SourceMapSliceBudgetV1,
  ): CommandResultV1<SourceMapFallbackSliceResultV1>;
}

interface ActiveSourceMapWorkV1 {
  readonly cancellation: Promise<CommandResultV1<SourceOffsetMapV1>>;
  cancel(code: "disposed" | "stale-source"): void;
}

export class SourceMapWorkOwnerV1 {
  #active: ActiveSourceMapWorkV1 | null = null;
  #disposed = false;

  async run(
    port: SourceMapWorkPortV1,
    request: NormalizedSourceMapCompositionRequestV1,
  ): Promise<CommandResultV1<SourceOffsetMapV1>> {
    if (this.#disposed) return commandFailure("disposed");
    this.#cancelActive("stale-source");
    let submission: SourceMapWorkSubmissionV1;
    try {
      submission = port.submit(request);
    } catch {
      return commandFailure("recovery-unavailable");
    }
    const active = createActiveSourceMapWork(submission);
    this.#active = active;
    try {
      const result = await Promise.race([
        submission.completion,
        active.cancellation,
      ]);
      if (this.#isDisposed()) return commandFailure("disposed");
      return this.#active === active ? result : commandFailure("stale-source");
    } catch {
      return commandFailure("recovery-unavailable");
    } finally {
      if (this.#active === active) this.#active = null;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelActive("disposed");
  }

  #isDisposed(): boolean {
    return this.#disposed;
  }

  #cancelActive(code: "disposed" | "stale-source"): void {
    const active = this.#active;
    if (active === null) return;
    this.#active = null;
    active.cancel(code);
  }
}

function createActiveSourceMapWork(
  submission: SourceMapWorkSubmissionV1,
): ActiveSourceMapWorkV1 {
  let cancelled = false;
  let resolveCancellation!: (
    result: CommandResultV1<SourceOffsetMapV1>,
  ) => void;
  const cancellation = new Promise<CommandResultV1<SourceOffsetMapV1>>(
    (resolve) => {
      resolveCancellation = resolve;
    },
  );
  return {
    cancellation,
    cancel: (code): void => {
      if (cancelled) return;
      cancelled = true;
      try {
        submission.cancel();
      } catch {
        // Cancellation still releases the owner and completion waiter.
      }
      resolveCancellation(commandFailure(code));
    },
  };
}
