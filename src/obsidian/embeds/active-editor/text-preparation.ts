import {
  canonicalizeGeometryNumber,
  type TextElementV2,
  type TextStyleV2,
  type FontResourceV2,
} from "../../../domain/schema/public";
import type { ChangeDesc } from "@codemirror/state";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { parseTextMarkdownSteps } from "../../../domain/text/markdown-parser";
import {
  TEXT_CODE_FONT_FAMILY,
  textTableFollowingGap,
} from "../../../domain/text/text-layout-style";
import type {
  TextMarkdownBlock,
  TextMarkdownDocument,
  TextMarkdownRun,
} from "../../../domain/text/text-types";
import type { FontFaceRequest } from "../../../persistence/fonts/font-resources";
import {
  CanvasTextMeasurer,
  type TextFontMeasurement,
} from "../../../rendering/text/canvas-text-measurer";
import { layoutTextMarkdown } from "../../../rendering/text/text-layout";
import { blockTextStyle } from "../../../rendering/text/text-layout-atoms";
import { ObsidianTextMathRenderer } from "../../text/math-renderer";
import type { SvgSceneRenderer } from "../../../rendering/scene/index";
import type { EditableDocumentModel } from "../document-session/document-model-port";
import {
  TextFontBindings,
  TextFontBindingLookup,
  textFontBindingsSteps,
  textBaseFontBinding,
  type TextFontBinding,
} from "./text-session-font-bindings";
import {
  TextSessionFonts,
  textFontRequest,
  textFontRequestKey,
  type TextFontLibraryPort,
} from "./text-session-fonts";
import type { TextSourceRange } from "../../../domain/text/text-types";
import { preserveTextReflowOrigin } from "../../../domain/geometry/text-reflow";
import { textPaddingForReflow } from "../../../domain/geometry/text-padding";
import { missingTextWhitespaceSteps } from "../../../rendering/text/text-layout-whitespace";
import { layoutTextTable } from "../../../rendering/text/text-table-layout";
import type { PreparedTextTable, TextMeasurer } from "../../../rendering/text/text-layout-types";
import { TextSessionMathBaselines } from "./text-session-math-baselines";

export type { TextFontLibraryPort } from "./text-session-fonts";

interface TextRunMeasurement {
  readonly style: TextStyleV2;
  readonly run: TextMarkdownRun;
}

export class ActiveTextPreparation {
  readonly #model: EditableDocumentModel;
  readonly #scheduler: WorkScheduler;
  readonly #measurer: CanvasTextMeasurer;
  readonly math: ObsidianTextMathRenderer;
  readonly #fonts: TextSessionFonts;
  readonly #bindings = new TextFontBindings();
  readonly #preparedBindings = new WeakMap<TextElementV2, readonly TextFontBinding[]>();
  readonly #tables = new WeakMap<TextMarkdownBlock, PreparedTextTable>();
  public readonly mathBaselines = new TextSessionMathBaselines();
  #parsed:
    | (Pick<TextElementV2, "source" | "style" | "ranges" | "paragraphs"> & {
        readonly document: TextMarkdownDocument;
        readonly requests: readonly FontFaceRequest[];
        readonly measurements: readonly TextRunMeasurement[];
      })
    | undefined;

  public constructor(options: {
    readonly model: EditableDocumentModel;
    readonly renderer: SvgSceneRenderer;
    readonly scheduler: WorkScheduler;
    readonly library?: TextFontLibraryPort;
  }) {
    this.#model = options.model;
    this.#scheduler = options.scheduler;
    this.#fonts = new TextSessionFonts(options);
    this.#measurer = new CanvasTextMeasurer(options.renderer.textDocument);
    this.math = new ObsidianTextMathRenderer(options.scheduler);
  }

  public async prepare(
    element: TextElementV2,
    signal: AbortSignal,
    options: { readonly preservePadding?: boolean } = {},
  ): Promise<TextElementV2> {
    const { document, requests, measurements } = await this.#parse(element, signal);
    const previous = this.#model.store?.get(element.id)?.element;
    const retained =
      this.#bindings.id === element.id
        ? this.#bindings.retained
        : previous?.kind === "text"
          ? await this.#indexBindings(previous as TextElementV2, signal)
          : [];
    const base =
      this.#bindings.id === element.id
        ? this.#bindings.base
        : textBaseFontBinding(previous?.kind === "text" ? (previous as TextElementV2) : element);
    const lookup =
      this.#bindings.id === element.id
        ? this.#bindings.snapshot()
        : new TextFontBindingLookup(retained, undefined, base);
    const faces = await this.#fonts.load(requests, signal, { retained, ...(base ? { base } : {}) });
    const baseFontResourceId =
      lookup.resolve(element.style) ??
      faces.get(textFontRequestKey(textFontRequest(element.style)))?.id;
    signal.throwIfAborted();
    const measure = this.#layoutMeasure(lookup, faces);
    await this.#measurer.prepareLineMetrics(this.#metricRequests(measurements, measure), {
      scheduler: this.#scheduler,
      signal,
    });
    const result = await layoutTextMarkdown(
      {
        document,
        width: element.width,
        style: element.style,
        ...(element.layout.padding === undefined
          ? {}
          : {
              padding: options.preservePadding
                ? element.layout.padding
                : textPaddingForReflow(
                    element,
                    previous?.kind === "text" ? previous.style.fontSize : undefined,
                  ),
            }),
        ...(baseFontResourceId ? { baseFontResourceId } : {}),
      },
      {
        measure,
        math: this.math,
        scheduler: this.#scheduler,
        signal,
        onTablePrepared: (block, layout) => this.#tables.set(block, layout),
      },
    );
    const height = canonicalizeGeometryNumber(result.height);
    const prepared = preserveTextReflowOrigin(element, {
      ...element,
      height,
      layout: result.layout,
    });
    this.#preparedBindings.set(prepared, await this.#indexBindings(prepared, signal));
    return prepared;
  }

  public async open(element: TextElementV2, signal: AbortSignal): Promise<void> {
    const bindings = await this.#indexBindings(element, signal);
    const base = textBaseFontBinding(element);
    const { document, requests } = await this.#parse(element, signal);
    const faces = await this.#fonts.load(requests, signal, {
      retained: bindings,
      preserveEmbedded: true,
      ...(base ? { base } : {}),
    });
    await this.mathBaselines.open(element, document, {
      measure: this.#layoutMeasure(new TextFontBindingLookup(bindings, undefined, base), faces),
      native: this.#measurer,
      scheduler: this.#scheduler,
      signal,
    });
    this.#bindings.adopt(element.id, bindings, base);
  }

  public async prepareTable(
    block: TextMarkdownBlock,
    element: TextElementV2,
    width: number,
    signal: AbortSignal,
  ) {
    const cached = this.#tables.get(block);
    if (cached?.table.width === width) return cached;
    const { requests } = await this.#parse(element, signal);
    const lookup = this.#bindings.snapshot();
    const faces = await this.#fonts.load(requests, signal, {
      retained: this.#bindings.retained,
      ...(this.#bindings.base ? { base: this.#bindings.base } : {}),
    });
    const layout = await layoutTextTable(
      block,
      { width, top: 0, style: element.style },
      {
        measure: this.#layoutMeasure(lookup, faces),
        math: this.math,
        scheduler: this.#scheduler,
        signal,
      },
      element.source,
    );
    this.#tables.set(block, layout);
    return layout;
  }

  public async repairWhitespaceLayout(
    element: TextElementV2,
    signal: AbortSignal,
  ): Promise<TextElementV2> {
    const document = this.document(element);
    return document &&
      (await this.#complete(
        missingTextWhitespaceSteps(
          document,
          element.layout,
          textTableFollowingGap(element.style.fontSize),
        ),
        signal,
      ))
      ? this.prepare(element, signal, { preservePadding: true })
      : element;
  }

  public adopt(element: TextElementV2): void {
    this.mathBaselines.adopt(element);
    const bindings = this.#preparedBindings.get(element);
    if (bindings !== undefined) {
      this.#bindings.adopt(element.id, bindings, textBaseFontBinding(element));
    }
  }

  public mapChanges(changes: ChangeDesc): void {
    this.mathBaselines.clear();
    this.#bindings.map(changes);
  }

  public clearBindings(): void {
    this.mathBaselines.clear();
    this.#bindings.clear();
  }

  public readonly resolveFontResourceId = (
    style: TextStyleV2,
    range?: TextSourceRange,
  ): string | undefined =>
    this.#bindings.snapshot().resolve(style, range) ?? this.#fonts.resource(style)?.id;

  public readonly fontResourceBoundaries = (start: number, end: number): readonly number[] =>
    this.#bindings.snapshot().boundaries(start, end);

  #layoutMeasure(
    lookup: TextFontBindingLookup,
    faces: ReadonlyMap<string, FontResourceV2>,
  ): TextMeasurer {
    return {
      measure: (text, style, id) => this.#measurer.measure(text, style, id),
      resolveFontResourceId: (style, range) =>
        lookup.resolve(style, range) ?? faces.get(textFontRequestKey(textFontRequest(style)))?.id,
      fontResourceBoundaries: (start, end) => lookup.boundaries(start, end),
    };
  }

  *#metricRequests(
    measurements: readonly TextRunMeasurement[],
    measure: TextMeasurer,
  ): Generator<TextFontMeasurement> {
    for (const { run, style } of measurements) {
      const direct = run.contentEnd - run.contentStart === run.text.length;
      let start = direct ? run.contentStart : run.start;
      const end = direct ? run.contentEnd : run.end;
      const boundaries = direct ? (measure.fontResourceBoundaries?.(start, end) ?? []) : [];
      for (const to of [...boundaries, end]) {
        const fontResourceId = measure.resolveFontResourceId?.(style, { start, end: to });
        yield { style, ...(fontResourceId === undefined ? {} : { fontResourceId }) };
        start = to;
      }
    }
  }

  async #indexBindings(
    element: TextElementV2,
    signal: AbortSignal,
  ): Promise<readonly TextFontBinding[]> {
    return this.#complete(textFontBindingsSteps(element), signal);
  }

  async #complete<T>(steps: Generator<void, T>, signal: AbortSignal): Promise<T> {
    let step = steps.next();
    while (!step.done) {
      const pending = this.#scheduler.checkpoint(signal, "frame");
      if (pending !== undefined) await pending;
      signal.throwIfAborted();
      step = steps.next();
    }
    return step.value;
  }

  public document(element: TextElementV2): TextMarkdownDocument | undefined {
    return this.#matches(element) ? this.#parsed?.document : undefined;
  }

  #matches(element: TextElementV2): boolean {
    const previous = this.#parsed;
    return (
      previous !== undefined &&
      previous.source === element.source &&
      previous.style === element.style &&
      previous.ranges === element.ranges &&
      previous.paragraphs === element.paragraphs
    );
  }

  async #parse(element: TextElementV2, signal: AbortSignal) {
    if (this.#matches(element)) return this.#parsed!;
    const document = await this.#complete(parseTextMarkdownSteps(element.source, element), signal);
    const requests = new Map<string, FontFaceRequest>();
    const measurements: TextRunMeasurement[] = [];
    const include = (style: TextElementV2["style"]) => {
      const request = textFontRequest(style);
      requests.set(`${request.family}:${request.weight}:${request.style}`, request);
    };
    let hasGlyphs = false;
    for (const block of document.blocks) {
      if (block.list) {
        include(blockTextStyle(block, element.style));
        hasGlyphs = true;
      }
      for (const run of block.runs) {
        const style = blockTextStyle(
          block,
          run.code ? { ...run.style, fontFamily: TEXT_CODE_FONT_FAMILY } : run.style,
        );
        if (run.kind === "text" && run.text.length > 0) {
          include(style);
          measurements.push({ style, run });
          hasGlyphs = true;
        } else if (run.kind === "math") include({ ...style, fontFamily: TEXT_CODE_FONT_FAMILY });
        const pending = this.#scheduler.checkpoint(signal, "frame");
        if (pending !== undefined) await pending;
        signal.throwIfAborted();
      }
    }
    if (!hasGlyphs) include(element.style);
    this.#parsed = {
      source: element.source,
      style: element.style,
      ranges: element.ranges,
      paragraphs: element.paragraphs,
      document,
      requests: [...requests.values()],
      measurements,
    };
    return this.#parsed;
  }

  public dispose(): void {
    this.mathBaselines.clear();
    this.#measurer.dispose();
    this.math.dispose();
    this.#fonts.dispose();
    this.#bindings.clear();
    this.#parsed = undefined;
  }
}
