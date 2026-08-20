import { commandFailure, commandSuccess } from "../note-session/results";
import type { CommandResultV1 } from "../note-session/types";
import {
  materializeSourceMapPath,
  type SourceMapGraphNodeV1,
} from "./map-graph";
import type { SourceOffsetMapV1, SourceSnapshotV1 } from "./types";
import type { HistoryMaterializationWorkPortV1 } from "./work-ports";

interface HistoryMaterializationInputV1<T> {
  readonly sourceGeneration: SourceMapGraphNodeV1;
  readonly value: T;
}

export interface HistoryMaterializationWorkV1<T> {
  readonly offsetMap: SourceOffsetMapV1;
  readonly priorSnapshot: SourceSnapshotV1;
  readonly replacementSnapshot: SourceSnapshotV1;
  readonly value: T;
  readonly visitedNodes: number;
}

export interface HistoryMaterializationRequestV1<T, R> {
  readonly currentSource: () => SourceMapGraphNodeV1;
  readonly entryKey: string;
  readonly input: HistoryMaterializationInputV1<T>;
  readonly materialize?: (
    work: HistoryMaterializationWorkV1<T>,
  ) => Promise<CommandResultV1<R>>;
  readonly workPort?: HistoryMaterializationWorkPortV1<T, R>;
}

export class HistoryMaterializationCoordinatorV1 {
  readonly #generations = new Map<string, number>();
  readonly #cancellers = new Map<string, () => void>();
  #disposed = false;
  #lifecycleGeneration = 0;

  async materialize<T, R>(
    request: HistoryMaterializationRequestV1<T, R>,
  ): Promise<CommandResultV1<R>> {
    if (this.#disposed) return commandFailure("disposed");
    if (
      (request.materialize === undefined) ===
      (request.workPort === undefined)
    ) {
      return commandFailure("invalid-command");
    }
    const lifecycleGeneration = this.#lifecycleGeneration;
    const target = request.currentSource();
    const path = materializeSourceMapPath(
      request.input.sourceGeneration,
      target,
    );
    if (!path.ok) return path;
    const generation = this.#begin(request.entryKey);
    const work = Object.freeze({
      offsetMap: path.value.offsetMap,
      priorSnapshot: request.input.sourceGeneration.snapshot,
      replacementSnapshot: target.snapshot,
      value: request.input.value,
      visitedNodes: path.value.visitedNodes,
    });
    const submission =
      request.workPort === undefined ? null : request.workPort.submit(work);
    const cancelSubmission =
      submission === null ? null : (): void => submission.cancel();
    if (cancelSubmission !== null) {
      this.#cancellers.set(request.entryKey, cancelSubmission);
    }
    let result: CommandResultV1<R> | undefined;
    try {
      result =
        submission === null
          ? await request.materialize?.(work)
          : await submission.completion;
    } finally {
      if (
        cancelSubmission !== null &&
        this.#cancellers.get(request.entryKey) === cancelSubmission
      ) {
        this.#cancellers.delete(request.entryKey);
      }
    }
    if (result === undefined) return commandFailure("invalid-command");
    if (this.#lifecycleGeneration !== lifecycleGeneration) {
      return commandFailure("disposed");
    }
    if (
      this.#generations.get(request.entryKey) !== generation ||
      request.currentSource() !== target
    ) {
      return commandFailure("stale-source");
    }
    return result.ok ? commandSuccess(result.value) : result;
  }

  cancel(entryKey: string): void {
    if (this.#disposed) return;
    this.#cancellers.get(entryKey)?.();
    this.#begin(entryKey);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifecycleGeneration += 1;
    for (const cancel of this.#cancellers.values()) cancel();
    this.#cancellers.clear();
    this.#generations.clear();
  }

  #begin(entryKey: string): number {
    const next = (this.#generations.get(entryKey) ?? 0) + 1;
    this.#generations.set(entryKey, next);
    return next;
  }
}
