import { TEXT_LINE_HEIGHT } from "../../domain/text/text-layout-style";

interface CssTextLineMetrics {
  readonly ascent: number;
  readonly descent: number;
  readonly lineHeight: number;
}

export const MAX_FONT_METRICS = 256;
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const PROBE_STYLES = `.inkbook-text-line-probe {
  all: initial; position: fixed; left: 0; top: 0; display: block;
  margin: 0; padding: 0; border: 0; visibility: hidden;
  pointer-events: none; white-space: nowrap; contain: layout style;
}
.inkbook-text-line-baseline {
  all: initial; display: inline-block; width: 0; height: 0;
  margin: 0; padding: 0; border: 0; vertical-align: baseline;
}`;

/** Native CSS line boxes avoid Canvas fontBoundingBox integer quantization.
 * The caller obtains shared WorkScheduler admission before this indivisible layout read.
 */
export class CssTextLineMeasurer {
  readonly #document: Document;
  readonly #cache = new Map<string, CssTextLineMetrics>();
  readonly #pending = new Set<HTMLDivElement>();
  #probe: HTMLDivElement | undefined;
  #baseline: HTMLSpanElement | undefined;
  #stylesheet: HTMLStyleElement | undefined;

  public constructor(ownerDocument: Document) {
    this.#document = ownerDocument;
  }

  public measure(font: string): CssTextLineMetrics {
    const cached = this.#cache.get(font);
    if (cached) return cached;
    this.#ensureProbe();
    const probe = this.#probe!;
    probe.style.setProperty("font", font);
    probe.style.setProperty("line-height", String(TEXT_LINE_HEIGHT));
    return this.#retain(font, this.#read(probe, this.#baseline!));
  }

  /** Write all requested fonts before reading their exact native line boxes. */
  public *prepareSteps(fonts: ReadonlySet<string>): Generator<void> {
    const probes: { font: string; probe: HTMLDivElement; baseline: HTMLSpanElement }[] = [];
    try {
      for (const font of fonts) {
        if (this.#cache.has(font)) continue;
        if (this.#pending.size >= MAX_FONT_METRICS) break;
        this.#ensureStylesheet();
        const entry = { font, ...this.#createProbe() };
        entry.probe.style.setProperty("font", font);
        entry.probe.style.setProperty("line-height", String(TEXT_LINE_HEIGHT));
        this.#pending.add(entry.probe);
        probes.push(entry);
        this.#document.body.append(entry.probe);
        yield;
      }
      for (const entry of probes) {
        this.#retain(entry.font, this.#read(entry.probe, entry.baseline));
        yield;
      }
    } finally {
      for (const { probe } of probes) {
        probe.remove();
        this.#pending.delete(probe);
      }
    }
  }

  #read(probe: HTMLDivElement, baseline: HTMLSpanElement): CssTextLineMetrics {
    const box = probe.getBoundingClientRect();
    const ascent = baseline.getBoundingClientRect().top - box.top;
    if (
      !Number.isFinite(ascent) ||
      !Number.isFinite(box.height) ||
      ascent < 0 ||
      ascent > box.height
    )
      throw new Error("Native text line measurement is unavailable.");
    return { ascent, descent: box.height - ascent, lineHeight: box.height };
  }

  #retain(font: string, result: CssTextLineMetrics): CssTextLineMetrics {
    this.#cache.delete(font);
    if (this.#cache.size >= MAX_FONT_METRICS) this.#cache.delete(this.#cache.keys().next().value!);
    this.#cache.set(font, result);
    return result;
  }

  public clear(): void {
    this.#cache.clear();
  }

  public dispose(): void {
    this.clear();
    this.#probe?.remove();
    this.#stylesheet?.remove();
    this.#probe = undefined;
    this.#baseline = undefined;
    this.#stylesheet = undefined;
    for (const probe of this.#pending) probe.remove();
    this.#pending.clear();
  }

  #ensureProbe(): void {
    if (this.#probe) return;
    this.#ensureStylesheet();
    const { probe, baseline } = this.#createProbe();
    this.#document.body.append(probe);
    this.#probe = probe;
    this.#baseline = baseline;
  }

  #ensureStylesheet(): void {
    if (this.#stylesheet) return;
    const stylesheet = this.#document.createElementNS(HTML_NAMESPACE, "style") as HTMLStyleElement;
    stylesheet.textContent = PROBE_STYLES;
    this.#document.head.append(stylesheet);
    this.#stylesheet = stylesheet;
  }

  #createProbe(): { probe: HTMLDivElement; baseline: HTMLSpanElement } {
    const probe = this.#document.createElementNS(HTML_NAMESPACE, "div") as HTMLDivElement;
    probe.setAttribute("class", "inkbook-text-line-probe");
    probe.setAttribute("aria-hidden", "true");
    const baseline = this.#document.createElementNS(HTML_NAMESPACE, "span");
    baseline.setAttribute("class", "inkbook-text-line-baseline");
    probe.append(this.#document.createTextNode("M"), baseline);
    return { probe, baseline };
  }
}
