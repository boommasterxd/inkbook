import type { ChangeDesc, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { TextElementV2 } from "../../../domain/schema/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { TextMarkdownDocument, TextSourceState } from "../../../domain/text/text-types";
import type { TextPreviewController } from "./text-preview-controller";
import type { IndexedTextPreview } from "./text-preview-index";
import { normalizedTextSourceSteps, type TextSourceController } from "./text-source-controller";
import { runTextEditorWork } from "./text-editor-work";
import type { PreparedTextDecorations } from "./text-preview-decorations";
import { sameTextStyle } from "../../../domain/text/text-layout-style";

interface PreparedEditorGeometry {
  readonly element: TextElementV2;
  readonly document: Text;
  readonly preview: IndexedTextPreview;
  readonly state: TextSourceState;
  readonly normalization: ChangeDesc | undefined;
  readonly decorations: PreparedTextDecorations;
}

interface NativeEditorGeometry {
  readonly element: TextElementV2;
  readonly document: Text;
}

export type TextHeightMeasured = (height: number | undefined) => void;

/** One staged native layout publishes with its matching scene width and font metrics. */
export class TextEditorGeometry {
  #prepared: PreparedEditorGeometry | undefined;
  #disposed = false;
  #backgroundPending = false;
  #preparing: AbortController | undefined;
  #heightCompletion: TextHeightMeasured | undefined;
  #native: NativeEditorGeometry | undefined;

  public constructor(
    private readonly options: {
      readonly view: EditorView;
      readonly scheduler: WorkScheduler;
      readonly source: TextSourceController;
      readonly preview: TextPreviewController;
      readonly element: () => TextElementV2;
      readonly setElement: (element: TextElementV2) => void;
      readonly updateStyle: () => void;
      readonly replaceSource: (source: string) => void;
      readonly invalidateBackground: () => void;
      readonly publishBackground: (style: CSSStyleDeclaration | undefined) => void;
      readonly refreshTables: () => void;
      readonly prepareDecorations: (
        preview: IndexedTextPreview,
        element: TextElementV2,
        signal: AbortSignal,
      ) => Promise<PreparedTextDecorations>;
    },
  ) {
    this.#native = { element: options.element(), document: options.view.state.doc };
  }

  public async prepare(
    element: TextElementV2,
    signal: AbortSignal,
    cached?: TextMarkdownDocument,
  ): Promise<void> {
    this.#preparing?.abort();
    signal.throwIfAborted();
    if (!this.#disposed && this.#matches(this.#native, element)) {
      this.#prepared = undefined;
      return;
    }
    const preparing = new AbortController();
    this.#preparing = preparing;
    const cancel = () => preparing.abort();
    signal.addEventListener("abort", cancel, { once: true, signal: preparing.signal });
    if (signal.aborted || this.#disposed) preparing.abort();
    try {
      await this.#prepare(element, preparing.signal, cached);
    } finally {
      signal.removeEventListener("abort", cancel);
      if (this.#preparing === preparing) this.#preparing = undefined;
    }
  }

  async #prepare(
    element: TextElementV2,
    signal: AbortSignal,
    cached?: TextMarkdownDocument,
  ): Promise<void> {
    const document = this.options.view.state.doc;
    let normalized: Pick<PreparedEditorGeometry, "state" | "normalization"> | undefined;
    await runTextEditorWork(
      normalizedTextSourceSteps(element),
      this.options.scheduler,
      signal,
      (value) => {
        normalized = value;
      },
    );
    signal.throwIfAborted();
    const { state, normalization } = normalized!;
    if (this.#disposed || state.source !== document.toString()) return;
    const preview = await this.options.preview.prepare(state, element.style, signal, cached);
    const decorations = await this.options.prepareDecorations(preview, element, signal);
    if (!this.#disposed && document === this.options.view.state.doc)
      this.#prepared = { element, document, preview, state, normalization, decorations };
  }

  public update(element: TextElementV2): void {
    if (this.#disposed) return;
    const { source, preview } = this.options;
    const previous = this.options.element();
    const prepared = this.#take(element);
    const sameSource = sameTextSource(element, previous);
    const preserveNative = sameSource || (source.pending && element.source === source.state.source);
    const normalizedSource =
      element.source === previous.source && source.normalization !== undefined;
    const sourceChanged =
      !prepared && !preserveNative && !normalizedSource && element.source !== source.state.source;
    const bindingsChanged = element.layout !== previous.layout;
    const stylesChanged =
      !sameTextStyle(element.style, previous.style) ||
      element.ranges !== previous.ranges ||
      element.paragraphs !== previous.paragraphs;
    this.#retainNative(element, prepared);
    this.options.setElement(element);
    if (prepared) source.adoptNormalized(prepared.state, prepared.normalization);
    else if (!preserveNative) {
      source.replace({
        source: element.source,
        ranges: element.ranges,
        paragraphs: element.paragraphs,
      });
      source.normalizeLineEndings(element.source);
    }
    this.options.updateStyle();
    if (sourceChanged) this.options.replaceSource(element.source);
    if (prepared)
      preview.adopt(prepared.preview, source.state, element.style, prepared.decorations);
    else if (sourceChanged || stylesChanged) preview.invalidate(true);
    else if (bindingsChanged) preview.invalidate(false);
    this.options.invalidateBackground();
    this.#backgroundPending = true;
    if (stylesChanged && !sourceChanged) this.options.refreshTables();
  }

  public dispose(): void {
    this.#disposed = true;
    this.#preparing?.abort();
    const complete = this.#heightCompletion;
    this.#heightCompletion = undefined;
    complete?.(undefined);
    this.#prepared = undefined;
    this.#native = undefined;
  }

  public measureHeight(onMeasured?: TextHeightMeasured): number | undefined {
    if (this.#disposed) return undefined;
    if (onMeasured) {
      if (this.#heightCompletion !== onMeasured) {
        this.#heightCompletion?.(undefined);
        this.#heightCompletion = onMeasured;
      }
      this.options.view.requestMeasure({
        key: this,
        read: () => this.#readHeight(),
        write: (height) => this.#completeHeight(onMeasured, height),
      });
      return undefined;
    }
    return this.#readHeight(true);
  }

  #completeHeight(onMeasured: TextHeightMeasured, height: number | undefined): void {
    if (this.#heightCompletion !== onMeasured) return;
    this.#heightCompletion = undefined;
    onMeasured(height);
  }

  #readHeight(publish = false): number | undefined {
    if (this.#disposed) return undefined;
    const view = this.options.view;
    const style = view.dom.ownerDocument.defaultView?.getComputedStyle(view.dom);
    const height = Number.parseFloat(style?.height ?? "");
    if (publish && this.#backgroundPending) {
      this.#backgroundPending = false;
      this.options.publishBackground(style);
    }
    return Number.isFinite(height) && height >= 0 ? height : undefined;
  }

  #take(element: TextElementV2): PreparedEditorGeometry | undefined {
    const prepared = this.#prepared;
    const matches = this.#matches(prepared, element);
    if (matches || prepared?.document !== this.options.view.state.doc) this.#prepared = undefined;
    return matches ? prepared : undefined;
  }

  #retainNative(element: TextElementV2, prepared: PreparedEditorGeometry | undefined): void {
    if (prepared) this.#native = { element, document: prepared.document };
    else if (!this.#matches(this.#native, element)) this.#native = undefined;
  }

  #matches(native: NativeEditorGeometry | undefined, element: TextElementV2): boolean {
    const original = native?.element;
    return (
      original !== undefined &&
      native?.document === this.options.view.state.doc &&
      original.source === element.source &&
      sameTextStyle(original.style, element.style) &&
      original.ranges === element.ranges &&
      original.paragraphs === element.paragraphs &&
      original.layout === element.layout &&
      original.width === element.width
    );
  }
}

function sameTextSource(left: TextSourceState, right: TextSourceState): boolean {
  return (
    left.source === right.source &&
    left.ranges === right.ranges &&
    left.paragraphs === right.paragraphs
  );
}
