import type { EditorView } from "@codemirror/view";
import type { TextStyleV2 } from "../../../domain/schema/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { parseTextMarkdownSteps } from "../../../domain/text/markdown-parser";
import type { TextMarkdownDocument, TextSourceState } from "../../../domain/text/text-types";
import {
  setTextPreview,
  setTextViewport,
  setPreparedTextDecorations,
  type PreparedTextDecorations,
} from "./text-preview-decorations";
import { indexTextPreviewSteps, type IndexedTextPreview } from "./text-preview-index";
import { runTextEditorWork } from "./text-editor-work";
import { setTextLineBoundaries, textLineBoundariesSteps } from "./text-line-boundaries";
import type { Text } from "@codemirror/state";
import { TextEditorReadiness } from "./text-editor-readiness";

/** One coalesced parser job; stale continuations never publish into a newer document. */
export class TextPreviewController {
  readonly #readiness = new TextEditorReadiness();
  public readonly ready = this.#readiness.ready;
  readonly #scheduler: WorkScheduler;
  readonly #current: () => { state: TextSourceState; style: TextStyleV2; pending: boolean };
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #cached: (() => TextMarkdownDocument | undefined) | undefined;
  #view: EditorView | undefined;
  #pending: number | undefined;
  #parse = true;
  #abort = new AbortController();
  #disposed = false;
  #parsed: TextMarkdownDocument | undefined;
  #boundaryDocument: Text | undefined;
  #preparedState: TextSourceState | undefined;
  #preparedStyle: TextStyleV2 | undefined;

  public get parsed(): TextMarkdownDocument | undefined {
    const current = this.#current();
    return this.#preparedState?.source === current.state.source &&
      this.#preparedState.ranges === current.state.ranges &&
      this.#preparedState.paragraphs === current.state.paragraphs &&
      this.#preparedStyle === current.style
      ? this.#parsed
      : undefined;
  }

  public constructor(
    scheduler: WorkScheduler,
    current: () => { state: TextSourceState; style: TextStyleV2; pending: boolean },
    onError?: (error: unknown) => void,
    cached?: () => TextMarkdownDocument | undefined,
  ) {
    this.#scheduler = scheduler;
    this.#current = current;
    this.#onError = onError;
    this.#cached = cached;
  }

  public attach(view: EditorView): void {
    this.#view = view;
    this.invalidate(true);
  }

  public invalidate(parse: boolean): void {
    if (this.#disposed) return;
    if (parse) {
      this.#abort.abort();
      this.#abort = new AbortController();
      this.#parse = true;
    }
    if (this.#pending !== undefined) return;
    this.#pending = this.#scheduler.requestFrame(() => {
      this.#pending = undefined;
      void this.#refresh().catch((error: unknown) => {
        if (!this.#disposed) {
          this.#readiness.reject(error);
          this.#onError?.(error);
        }
      });
    }, "input");
  }

  public suspend(): void {
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#parse = true;
    if (this.#pending !== undefined) this.#scheduler.cancelFrame(this.#pending);
    this.#pending = undefined;
  }

  public async prepare(
    state: TextSourceState,
    style: TextStyleV2,
    signal: AbortSignal,
    cached = this.#cached?.(),
  ): Promise<IndexedTextPreview> {
    let result: IndexedTextPreview | undefined;
    await runTextEditorWork(
      preparePreview(state, style, cached),
      this.#scheduler,
      signal,
      (value) => {
        result = value;
      },
    );
    signal.throwIfAborted();
    return result!;
  }

  /** Geometry publication shares one synchronous source/style/decoration update. */
  public adopt(
    prepared: IndexedTextPreview,
    state: TextSourceState,
    style: TextStyleV2,
    decorations?: PreparedTextDecorations,
  ): void {
    this.suspend();
    this.#parse = false;
    this.#publish(prepared, state, style, decorations);
  }

  #publish(
    prepared: IndexedTextPreview,
    state: TextSourceState,
    style: TextStyleV2,
    decorations?: PreparedTextDecorations,
  ): void {
    const view = this.#view;
    if (!view || this.#disposed) return;
    this.#parsed = prepared.document;
    this.#preparedState = state;
    this.#preparedStyle = style;
    view.dispatch({
      effects: [
        setTextPreview.of(prepared),
        setTextViewport.of(view.visibleRanges.map(({ from, to }) => ({ start: from, end: to }))),
        ...(decorations ? [setPreparedTextDecorations.of(decorations)] : []),
      ],
    });
    this.#readiness.resolve();
  }

  async #refresh(): Promise<void> {
    const view = this.#view;
    if (!view || this.#disposed) return;
    if (this.#current().pending) return;
    const viewport = view.visibleRanges.map(({ from, to }) => ({ start: from, end: to }));
    if (!this.#parse) {
      view.dispatch({ effects: setTextViewport.of(viewport) });
      return;
    }
    this.#parse = false;
    const { state, style } = this.#current();
    const signal = this.#abort.signal;
    if (this.#boundaryDocument !== view.state.doc) {
      const document = view.state.doc;
      const pending = runTextEditorWork(
        textLineBoundariesSteps(document),
        this.#scheduler,
        signal,
        (boundaries) => {
          if (this.#disposed) return;
          this.#boundaryDocument = document;
          view.dispatch({ effects: setTextLineBoundaries.of(boundaries) });
        },
      );
      if (pending) await pending;
      if (signal.aborted || this.#disposed) return;
    }
    await runTextEditorWork(
      preparePreview(state, style, this.#cached?.()),
      this.#scheduler,
      signal,
      (prepared) => this.#publish(prepared, state, style),
    );
  }

  public dispose(): void {
    this.#disposed = true;
    this.#abort.abort();
    if (this.#pending !== undefined) this.#scheduler.cancelFrame(this.#pending);
    this.#pending = undefined;
    this.#view = undefined;
    this.#readiness.resolve();
  }
}

function* preparePreview(
  state: TextSourceState,
  style: TextStyleV2,
  cached?: TextMarkdownDocument,
): Generator<void, IndexedTextPreview> {
  const parsed =
    cached?.source === state.source
      ? cached
      : yield* parseTextMarkdownSteps(state.source, { ...state, style });
  return yield* indexTextPreviewSteps(parsed);
}
