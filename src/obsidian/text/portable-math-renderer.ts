import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js";
import type { LiteElement } from "@mathjax/src/js/adaptors/lite/Element.js";
import { HTMLHandler } from "@mathjax/src/js/handlers/html/HTMLHandler.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import { SVG } from "@mathjax/src/js/output/svg.js";
import "@mathjax/src/js/input/tex/base/BaseConfiguration.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js";
import "@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js";
import { OfflineMathFont } from "./math-font-data";
import { throwTexRenderError } from "./tex-syntax-error";

import type { FrameCancellation, WorkScheduler } from "../../domain/scheduling/work-scheduler";
import {
  MAX_TEXT_LAYOUT_ITEMS,
  MAX_TEXT_SOURCE_LENGTH,
} from "../../domain/schema/text-validation-primitives";
import { normalizeMathSvg, type MathSvgTree } from "../../rendering/text/svg-math-normalizer";
import { fitTextMathGeometry } from "../../rendering/text/math-geometry-fit";
import {
  assertTextLayoutActive,
  type ResolvedTextMath,
  type TextMathResolver,
  type TextMathStyle,
} from "../../rendering/text/text-layout-types";

const MAX_CACHE_PATH_CHARACTERS = 2_000_000;
// A supported field fits in full. Each key adds at most 64 characters for two
// finite numbers, mode and separators beyond its bounded TeX source.
const MAX_CACHE_KEY_CHARACTERS = MAX_TEXT_SOURCE_LENGTH + MAX_TEXT_LAYOUT_ITEMS * 64;
const MAX_FORMULA_LENGTH = 8192;

interface CachedMath {
  readonly value: ResolvedTextMath;
  readonly pathCharacters: number;
  readonly keyCharacters: number;
  readonly items: number;
}

export function assertTextMathInput(
  latex: string,
  fontSize: number,
  availableWidth?: number,
): void {
  if (
    latex.length > MAX_FORMULA_LENGTH ||
    !Number.isFinite(fontSize) ||
    fontSize <= 0 ||
    fontSize > 4096
  )
    throw new Error("Math expression exceeds the supported limits.");
  if (availableWidth !== undefined && (!Number.isFinite(availableWidth) || availableWidth < 0))
    throw new Error("Invalid math container width.");
}

/** The owner supplies the shared window scheduler; this engine performs no network or DOM work. */
export class PortableMathRenderer implements TextMathResolver {
  readonly #adaptor = liteAdaptor();
  readonly #font: OfflineMathFont;
  readonly #scheduler: WorkScheduler;
  readonly #cache = new Map<string, CachedMath>();
  readonly #lifetime = new AbortController();
  #pathCharacters = 0;
  #keyCharacters = 0;
  #items = 0;
  #disposed = false;

  public constructor(scheduler: WorkScheduler) {
    this.#scheduler = scheduler;
    this.#font = new OfflineMathFont(scheduler, this.#lifetime.signal);
  }

  public async resolve(
    latex: string,
    display: boolean,
    fontSize: number,
    signal?: FrameCancellation,
    availableWidth?: number,
    options?: TextMathStyle,
  ): Promise<ResolvedTextMath> {
    assertTextLayoutActive(signal);
    if (this.#disposed) throw new Error("Math renderer disposed.");
    assertTextMathInput(latex, fontSize, availableWidth);
    const key = `${fontSize}:${display ? "display" : "inline"}:${availableWidth ?? "natural"}:${options?.bold ? "bold" : "normal"}:${latex}`;
    const cached = this.#cache.get(key);
    if (cached) {
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return cached.value;
    }
    if (availableWidth !== undefined) {
      const natural = await this.resolve(latex, display, fontSize, signal, undefined, options);
      assertTextLayoutActive(signal);
      if (this.#disposed) throw new Error("Math renderer disposed.");
      // A fitting expression has no container-dependent line breaks. Retain only
      // its natural key instead of one identical path payload per resize width.
      if (natural.width <= availableWidth) return natural;
    }
    const cancellation = linkedCancellation(this.#lifetime.signal, signal);
    const handoff = this.#scheduler.checkpoint(cancellation, "frame");
    if (handoff) await handoff;
    assertTextLayoutActive(cancellation);
    const { document, tex, output } = this.#createDocument(availableWidth, display);
    try {
      const node = (await document.convertPromise(textMathSource(latex, options), {
        display: display || availableWidth !== undefined,
        em: fontSize,
        ex: fontSize * this.#font.params.x_height,
        containerWidth: availableWidth === undefined ? 100_000 : Math.max(1, availableWidth),
      })) as LiteElement;
      const svg = this.#adaptor.tags(node, "svg")[0];
      if (!svg) throw new Error("Math SVG generation failed.");
      const natural = await normalizeMathSvg(
        svg,
        this.#tree(),
        fontSize,
        {
          scheduler: this.#scheduler,
          signal: cancellation,
        },
        availableWidth,
      );
      const value = await fitTextMathGeometry(natural, availableWidth, {
        scheduler: this.#scheduler,
        signal: cancellation,
      });
      assertTextLayoutActive(cancellation);
      this.#retain(key, value);
      return value;
    } finally {
      document.clear();
      if (output.adaptor) output.reset();
      tex.reset();
    }
  }

  public dispose(): void {
    this.#disposed = true;
    this.#lifetime.abort(new Error("Math renderer disposed."));
    this.#cache.clear();
    this.#pathCharacters = 0;
    this.#keyCharacters = 0;
    this.#items = 0;
  }

  #createDocument(availableWidth: number | undefined, display: boolean) {
    // Per-expression macros cannot become hidden dependencies of another saved field.
    const tex = new TeX<LiteElement, unknown, unknown>({
      packages: ["base", "ams", "newcommand", "boldsymbol"],
      maxBuffer: MAX_FORMULA_LENGTH + 32,
      maxMacros: 1000,
      formatError: (_jax: unknown, error: unknown) => throwTexRenderError(error),
    });
    if (!display && availableWidth !== undefined) {
      // The SVG display breaker emits one portable image. Preserve inline math
      // style before MathJax propagates inherited attributes to its parsed tree.
      tex.postFilters.add(() => {
        tex.parseOptions.root.attributes.set("display", "inline");
        tex.parseOptions.root.attributes.set("displaystyle", false);
      }, -7.5);
    }
    const output = new SVG<LiteElement, unknown, unknown>({
      fontData: this.#font,
      fontCache: "none",
      mtextInheritFont: false,
      merrorInheritFont: false,
      displayAlign: "left",
      displayOverflow: availableWidth === undefined ? "overflow" : "linebreak",
      linebreaks: { inline: false, width: "100%" },
    });
    return {
      tex,
      output,
      document: new HTMLHandler(this.#adaptor).create("", { InputJax: tex, OutputJax: output }),
    };
  }

  #tree(): MathSvgTree<LiteElement> {
    return {
      kind: (node) => this.#adaptor.kind(node),
      attribute: (node, name) => this.#attribute(node, name),
      children: (node) =>
        this.#adaptor
          .childNodes(node)
          .filter(
            (child): child is LiteElement => child.kind !== "#text" && child.kind !== "#comment",
          ),
    };
  }

  #attribute(node: LiteElement, name: string): string | null {
    const attribute: unknown = this.#adaptor.getAttribute(node, name);
    if (typeof attribute === "string" || typeof attribute === "number") return String(attribute);
    if (
      !this.#adaptor.hasAttribute(node, "data-line") &&
      !this.#adaptor.hasAttribute(node, "data-frame")
    )
      return null;
    // MathJax 4.1's SvgMtable.styles gives these rules a 70-unit solid stroke.
    // Materialize that local library style before removing the SVG stylesheet.
    if (name === "stroke-width") return this.#attribute(node, "stroke-thickness") ?? "70";
    if (name === "fill") return "none";
    if (name === "stroke-dasharray" && this.#adaptor.hasClass(node, "mjx-dashed")) return "140";
    if (name === "stroke-dasharray" && this.#adaptor.hasClass(node, "mjx-dotted")) return "0,140";
    return null;
  }

  #retain(key: string, value: ResolvedTextMath): void {
    const entry = {
      value,
      pathCharacters: value.paths.reduce((total, path) => total + path.d.length, 0),
      keyCharacters: key.length,
      items: value.paths.length + 1,
    };
    this.#remove(key);
    if (!this.#fits(entry, true)) return;
    while (this.#cache.size && !this.#fits(entry)) this.#remove(this.#cache.keys().next().value!);
    this.#cache.set(key, entry);
    this.#pathCharacters += entry.pathCharacters;
    this.#keyCharacters += entry.keyCharacters;
    this.#items += entry.items;
  }

  #fits(entry: CachedMath, empty = false): boolean {
    return (
      (empty ? 0 : this.#pathCharacters) + entry.pathCharacters <= MAX_CACHE_PATH_CHARACTERS &&
      (empty ? 0 : this.#keyCharacters) + entry.keyCharacters <= MAX_CACHE_KEY_CHARACTERS &&
      (empty ? 0 : this.#items) + entry.items <= MAX_TEXT_LAYOUT_ITEMS
    );
  }

  #remove(key: string): void {
    const entry = this.#cache.get(key);
    if (!entry) return;
    this.#pathCharacters -= entry.pathCharacters;
    this.#keyCharacters -= entry.keyCharacters;
    this.#items -= entry.items;
    this.#cache.delete(key);
  }
}

export function textMathSource(latex: string, options?: TextMathStyle): string {
  // A newline keeps a final TeX comment from consuming the closing group.
  return options?.bold ? `\\boldsymbol{${latex}\n}` : latex;
}

function linkedCancellation(
  lifetime: FrameCancellation,
  signal?: FrameCancellation,
): FrameCancellation {
  return {
    get aborted() {
      return lifetime.aborted || signal?.aborted === true;
    },
    get reason() {
      return signal?.aborted ? signal.reason : lifetime.reason;
    },
    addEventListener(type, callback, options) {
      lifetime.addEventListener(type, callback, options);
      signal?.addEventListener(type, callback, options);
    },
    removeEventListener(type, callback) {
      lifetime.removeEventListener(type, callback);
      signal?.removeEventListener(type, callback);
    },
  };
}
