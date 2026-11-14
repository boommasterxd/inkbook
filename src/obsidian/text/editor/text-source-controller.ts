import { type ChangeDesc, ChangeSet, type Range, RangeSet, RangeValue } from "@codemirror/state";
import type { TextRangeStyleV2 } from "../../../domain/schema/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import {
  applyTextEditsSteps,
  applyTextStyleRangeSteps,
} from "../../../domain/text/text-source-edits";
import type { TextSourceState } from "../../../domain/text/text-types";
import { runTextEditorWork } from "./text-editor-work";

class TypingStyle extends RangeValue {
  public override startSide = 1;
  public override endSide = 1;
  public constructor(readonly style: TextRangeStyleV2) {
    super();
  }
}

interface TextSourceControllerPorts {
  readonly onChange: (state: TextSourceState, changes?: ChangeDesc) => void;
  readonly onError: ((error: unknown) => void) | undefined;
  readonly onPending: ((pending: boolean) => void) | undefined;
  readonly onPrepared?: () => void;
}

/** Composed native changes retain input order while persistence preparation cooperatively yields. */
export class TextSourceController {
  readonly #scheduler: WorkScheduler;
  readonly #ports: TextSourceControllerPorts;
  #state: TextSourceState;
  #changes: ChangeSet | undefined;
  #styles: RangeSet<TypingStyle> = RangeSet.of<TypingStyle>([]);
  #frame: number | undefined;
  #abort = new AbortController();
  #disposed = false;
  #flushing: Promise<TextSourceState> | undefined;
  #semantic = false;
  #meaningfulUserInput = false;
  #unpublished: ChangeDesc | undefined;
  #unpublishedInverse: ChangeDesc | undefined;
  #pendingInverse: ChangeDesc | undefined;

  public constructor(
    state: TextSourceState,
    scheduler: WorkScheduler,
    ports: TextSourceControllerPorts,
  ) {
    this.#state = state;
    this.#scheduler = scheduler;
    this.#ports = ports;
  }

  public get state(): TextSourceState {
    return this.#state;
  }
  public get pending(): boolean {
    return this.#changes !== undefined;
  }
  public get hasMeaningfulUserInput(): boolean {
    return this.#meaningfulUserInput;
  }

  /** Rebase authoritative source offsets without rewriting the normalized native document. */
  public normalizeLineEndings(source: string): void {
    const changes = sourceLineEndingChanges(source);
    if (changes.length) this.record(ChangeSet.of(changes, source.length), {}, false);
  }

  public adoptNormalized(state: TextSourceState, normalization: ChangeDesc | undefined): void {
    this.replace(state);
    this.#unpublished = normalization;
    this.#unpublishedInverse = normalization?.invertedDesc;
  }

  public record(
    changes: ChangeSet,
    style: TextRangeStyleV2,
    semantic = true,
    userInput = semantic,
  ): void {
    if (this.#disposed || changes.empty) return;
    if (userInput && !this.#meaningfulUserInput) this.#recordUserInput(changes);
    this.#abort.abort();
    this.#abort = new AbortController();
    const wasSemantic = this.#semantic;
    this.#changes = this.#changes?.compose(changes) ?? changes;
    this.#pendingInverse = undefined;
    this.#semantic ||= semantic;
    if (!wasSemantic && this.#semantic) this.#ports.onPending?.(true);
    this.#styles = this.#styles.map(changes);
    if (Object.keys(style).length) {
      const add: Range<TypingStyle>[] = [];
      changes.iterChangedRanges((_from, _to, start, end) => {
        if (start < end) add.push(new TypingStyle(style).range(start, end));
      });
      this.#styles = this.#styles.update({ add, sort: true });
    }
    if (this.#frame === undefined && !this.#flushing) {
      this.#frame = this.#scheduler.requestFrame(() => {
        this.#frame = undefined;
        void this.#prepare().catch((error: unknown) => this.#ports.onError?.(error));
      }, "input");
    }
  }

  #recordUserInput(changes: ChangeSet): void {
    changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
      if (this.#meaningfulUserInput) return;
      const parts = inserted.iter();
      for (let part = parts.next(); !part.done; part = parts.next()) {
        if (/\S/u.test(part.value)) {
          this.#meaningfulUserInput = true;
          break;
        }
      }
    });
  }

  async #prepare(): Promise<void> {
    const signal = this.#abort.signal;
    await runTextEditorWork(this.#steps(), this.#scheduler, signal, (state) => {
      if (!this.#disposed) this.#publish(state);
    });
  }

  *#steps(): Generator<void, TextSourceState> {
    const changes: { start: number; end: number; insert: string }[] = [];
    this.#changes?.iterChanges((start, end, _newStart, _newEnd, insert) =>
      changes.push({ start, end, insert: insert.toString() }),
    );
    let state = yield* applyTextEditsSteps(this.#state, changes);
    for (let cursor = this.#styles.iter(); cursor.value; cursor.next()) {
      try {
        state = yield* applyTextStyleRangeSteps(
          state,
          { start: cursor.from, end: cursor.to },
          cursor.value.style,
        );
      } catch (error) {
        this.#ports.onError?.(error);
        break;
      }
    }
    return state;
  }

  #publish(state: TextSourceState): void {
    const changes = this.#changes;
    const semantic = this.#semantic;
    this.#state = state;
    this.#changes = undefined;
    this.#styles = RangeSet.of<TypingStyle>([]);
    this.#semantic = false;
    this.#pendingInverse = undefined;
    if (changes) {
      if (semantic) {
        const mapping = this.#unpublished?.composeDesc(changes) ?? changes;
        this.#clearNormalization();
        try {
          this.#ports.onChange(state, mapping);
        } finally {
          this.#ports.onPending?.(false);
        }
      } else {
        this.#unpublished = this.#unpublished?.composeDesc(changes) ?? changes;
        this.#unpublishedInverse = this.#unpublished.invertedDesc;
        this.#ports.onPrepared?.();
      }
    }
  }

  /** Explicit formatting/history/lifecycle boundaries may need the current native transaction atomically. */
  public flush(): TextSourceState {
    this.#abort.abort();
    if (this.#frame !== undefined) this.#scheduler.cancelFrame(this.#frame);
    this.#frame = undefined;
    const steps = this.#steps();
    let step = steps.next();
    while (!step.done) step = steps.next();
    this.#publish(step.value);
    return this.#state;
  }

  public replace(state: TextSourceState, preserveNormalization = false): void {
    this.#abort.abort();
    if (this.#frame !== undefined) this.#scheduler.cancelFrame(this.#frame);
    this.#frame = undefined;
    this.#state = state;
    const pending = this.#semantic;
    this.#changes = undefined;
    this.#styles = RangeSet.of<TypingStyle>([]);
    this.#semantic = false;
    this.#pendingInverse = undefined;
    if (!preserveNormalization) this.#clearNormalization();
    if (pending) this.#ports.onPending?.(false);
  }

  public get normalization(): ChangeDesc | undefined {
    return this.#unpublished;
  }

  public originalPosition(position: number, association: -1 | 1): number {
    if (this.#changes) {
      this.#pendingInverse ??= this.#changes.invertedDesc;
      position = this.#pendingInverse.mapPos(position, association);
    }
    return this.#unpublishedInverse?.mapPos(position, association) ?? position;
  }

  public publishStyle(): void {
    const changes = this.#unpublished;
    this.#clearNormalization();
    this.#ports.onChange(this.#state, changes);
  }

  #clearNormalization(): void {
    this.#unpublished = undefined;
    this.#unpublishedInverse = undefined;
  }

  public flushChanges(): Promise<TextSourceState> {
    if (this.#flushing) return this.#flushing;
    if (!this.pending) return Promise.resolve(this.#state);
    const flush = this.#flushChanges();
    this.#flushing = flush;
    void flush.then(
      () => {
        this.#flushing = undefined;
      },
      () => {
        this.#flushing = undefined;
      },
    );
    return flush;
  }

  async #flushChanges(): Promise<TextSourceState> {
    this.#abort.abort();
    this.#abort = new AbortController();
    if (this.#frame !== undefined) this.#scheduler.cancelFrame(this.#frame);
    this.#frame = undefined;
    while (this.pending && !this.#disposed) await this.#prepare();
    return this.#state;
  }

  public dispose(): void {
    this.#abort.abort();
    if (this.#frame !== undefined) this.#scheduler.cancelFrame(this.#frame);
    this.#frame = undefined;
    this.#disposed = true;
    if (this.#semantic) this.#ports.onPending?.(false);
    this.#semantic = false;
    this.#changes = undefined;
    this.#styles = RangeSet.of<TypingStyle>([]);
    this.#clearNormalization();
  }
}

export function* normalizedTextSourceSteps(
  state: TextSourceState,
): Generator<
  void,
  { readonly state: TextSourceState; readonly normalization: ChangeDesc | undefined }
> {
  state = { source: state.source, ranges: state.ranges, paragraphs: state.paragraphs };
  const changes = sourceLineEndingChanges(state.source);
  if (!changes.length) return { state, normalization: undefined };
  const normalization = ChangeSet.of(changes, state.source.length);
  return {
    state: yield* applyTextEditsSteps(
      state,
      changes.map(({ from, to, insert }) => ({ start: from, end: to, insert })),
    ),
    normalization,
  };
}

function sourceLineEndingChanges(source: string) {
  return source.includes("\r")
    ? [...source.matchAll(/\r\n?/gu)].map((match) => ({
        from: match.index,
        to: match.index + 1,
        insert: match[0].length === 2 ? "" : "\n",
      }))
    : [];
}
