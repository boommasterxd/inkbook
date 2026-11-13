import type { TextStyleV2 } from "../../domain/schema/public";
import { fontCssFamily, fontResourceCssFamily } from "../../domain/text/font-family";
import { CssTextLineMeasurer, MAX_FONT_METRICS } from "./css-text-line-metrics";
import { admitTextLayout, type TextLayoutPorts } from "./text-layout-types";
import type {
  MeasuredText,
  TextFontResourceBoundaries,
  TextFontResourceResolver,
  TextMeasurer,
} from "./text-layout-types";

const MAX_MEASUREMENTS = 2048;

export interface TextFontMeasurement {
  readonly style: TextStyleV2;
  readonly fontResourceId?: string;
}

/** One detached canvas belongs to the presentation's owning document. Load fonts first. */
export class CanvasTextMeasurer implements TextMeasurer {
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  readonly #cache = new Map<string, MeasuredText>();
  readonly #lines: CssTextLineMeasurer;
  readonly #resolveFont: TextFontResourceResolver | undefined;
  readonly #fontBoundaries: TextFontResourceBoundaries | undefined;
  #disposed = false;

  public constructor(
    ownerDocument: Document,
    resolveFontResourceId?: TextFontResourceResolver,
    fontResourceBoundaries?: TextFontResourceBoundaries,
  ) {
    this.#resolveFont = resolveFontResourceId;
    this.#fontBoundaries = fontResourceBoundaries;
    this.#lines = new CssTextLineMeasurer(ownerDocument);
    this.#canvas = ownerDocument.createElement("canvas");
    const context = this.#canvas.getContext("2d");
    if (!context) throw new Error("Text measurement is unavailable.");
    this.#context = context;
  }

  public resolveFontResourceId(
    style: TextStyleV2,
    range?: { readonly start: number; readonly end: number },
  ): string | undefined {
    return this.#resolveFont?.(style, range);
  }

  public fontResourceBoundaries(start: number, end: number): readonly number[] {
    return this.#fontBoundaries?.(start, end) ?? [];
  }

  public measure(text: string, style: TextStyleV2, boundFontResourceId?: string): MeasuredText {
    if (this.#disposed) throw new Error("Text measurer disposed.");
    const fontResourceId = boundFontResourceId ?? this.resolveFontResourceId(style);
    const font = measurementFont(style, fontResourceId);
    const key = `${font}\n${text}`;
    const cached = this.#cache.get(key);
    if (cached) return cached;
    this.#context.font = font;
    const metrics = this.#context.measureText(text);
    const result = {
      ...(fontResourceId === undefined ? {} : { fontResourceId }),
      width: metrics.width,
      ...this.#lines.measure(font),
    };
    if (this.#cache.size >= MAX_MEASUREMENTS) this.#cache.delete(this.#cache.keys().next().value!);
    this.#cache.set(key, result);
    return result;
  }

  public async prepareLineMetrics(
    requests: Iterable<TextFontMeasurement>,
    ports: Pick<TextLayoutPorts, "scheduler" | "signal">,
  ): Promise<void> {
    const fonts = new Set<string>();
    for (const request of requests) {
      await admitTextLayout(ports);
      if (this.#disposed) throw new Error("Text measurer disposed.");
      fonts.add(
        measurementFont(
          request.style,
          request.fontResourceId ?? this.resolveFontResourceId(request.style),
        ),
      );
      if (fonts.size >= MAX_FONT_METRICS) break;
    }
    const steps = this.#lines.prepareSteps(fonts);
    try {
      for (;;) {
        await admitTextLayout(ports);
        if (this.#disposed) throw new Error("Text measurer disposed.");
        if (steps.next().done) return;
      }
    } finally {
      steps.return(undefined);
    }
  }

  /** Font replacement invalidates native measurements, even when family names match. */
  public clear(): void {
    this.#cache.clear();
    this.#lines.clear();
  }

  public dispose(): void {
    this.#disposed = true;
    this.clear();
    this.#lines.dispose();
    this.#canvas.width = 0;
    this.#canvas.height = 0;
  }
}

function measurementFont(style: TextStyleV2, fontResourceId?: string): string {
  const family =
    fontResourceId === undefined
      ? fontCssFamily(style.fontFamily)
      : fontResourceCssFamily(fontResourceId);
  return `${style.italic ? "italic" : "normal"} ${style.bold ? 700 : 400} ${style.fontSize}px "${family}"`;
}
