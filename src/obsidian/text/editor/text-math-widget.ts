import type { EditorView } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import type { TextStyleV2 } from "../../../domain/schema/public";
import { TextMathSyntaxError } from "../../../rendering/text/text-math-syntax-error";
import type { TextMathRenderContext, TextMathWidgetPorts } from "./text-field-editor-types";
import { textStyleCss } from "./text-field-theme";
import { textFontFragments } from "./text-font-fragments";
import { TextPreviewWidget } from "./text-preview-widget";

interface TextMathPaint extends TextMathRenderContext {
  readonly css: string;
  readonly contentStart: number;
  readonly source: Text;
  readonly end: number;
  readonly literalStyle: TextStyleV2;
  readonly background: Readonly<Record<string, string>>;
  readonly alignment: "left" | "center" | "right" | "justify";
}

const mathMount = Symbol("inkbookMathMount");
interface MathNode extends HTMLElement {
  [mathMount]?: { widget: TextMathWidget; abort: AbortController };
}
type MathPaint = HTMLElement | TextMathSyntaxError;

/** Rendering belongs to this widget's DOM lifetime, including cancelled async results. */
export class TextMathWidget extends TextPreviewWidget {
  readonly #ports: TextMathWidgetPorts;
  #prepared: MathPaint | undefined;

  public constructor(
    public readonly latex: string,
    public readonly display: boolean,
    public readonly start: number,
    public readonly paint: TextMathPaint,
    ports: TextMathWidgetPorts,
  ) {
    super();
    this.#ports = ports;
  }

  public override eq(other: TextMathWidget): boolean {
    return (
      this.latex === other.latex &&
      this.display === other.display &&
      this.start === other.start &&
      this.paint.css === other.paint.css &&
      this.paint.availableWidth === other.paint.availableWidth &&
      this.paint.fontSize === other.paint.fontSize &&
      this.paint.layout === other.paint.layout &&
      this.paint.contentStart === other.paint.contentStart &&
      this.paint.alignment === other.paint.alignment &&
      JSON.stringify(this.paint.background) === JSON.stringify(other.paint.background) &&
      this.paint.end === other.paint.end &&
      (this.paint.source === other.paint.source ||
        this.paint.source
          .slice(this.start, this.paint.end)
          .eq(other.paint.source.slice(other.start, other.paint.end)))
    );
  }

  public override toDOM(view: EditorView): HTMLElement {
    const node: MathNode = view.dom.ownerDocument.createElement(this.display ? "div" : "span");
    node.className = "inkbook-text-math-widget";
    node.tabIndex = -1;
    node.textContent = this.latex;
    node[mathMount] = { widget: this, abort: new AbortController() };
    node.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const widget = node[mathMount]?.widget;
      if (widget) widget.#ports.activate(view, widget.paint.contentStart);
    });
    this.updateDOM(node, view);
    return node;
  }

  public override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const node = dom as MathNode;
    const state = node[mathMount];
    if (!state) return false;
    state.abort.abort();
    state.abort = new AbortController();
    state.widget = this;
    node.setAttribute("style", `${this.paint.css};text-align:${this.paint.alignment}`);
    node.classList.toggle("inkbook-text-math-display", this.display);
    if (this.#prepared) {
      this.#publish(node, this.#prepared, view);
      this.#prepared = undefined;
    } else this.#render(node, view, state.abort.signal);
    return true;
  }

  public override destroy(dom: HTMLElement): void {
    const node = dom as MathNode;
    node[mathMount]?.abort.abort();
    delete node[mathMount];
  }

  public async prepare(_view: EditorView, signal: AbortSignal): Promise<void> {
    const render = this.#ports.render;
    if (!render) return;
    try {
      this.#prepared = await render(this.latex, this.display, signal, this.#renderContext());
    } catch (error) {
      if (!(error instanceof TextMathSyntaxError)) throw error;
      this.#prepared = error;
    }
    signal.throwIfAborted();
  }

  #render(node: HTMLElement, view: EditorView, signal: AbortSignal): void {
    const render = this.#ports.render;
    if (render) {
      node.setAttribute("aria-busy", "true");
      void render(this.latex, this.display, signal, this.#renderContext()).then(
        (result) => {
          if (signal.aborted) return;
          this.#publish(node, result, view);
          view.requestMeasure();
          this.#ports.invalidateBackground?.();
        },
        (error: unknown) => {
          if (signal.aborted) return;
          node.removeAttribute("aria-busy");
          if (error instanceof TextMathSyntaxError) {
            try {
              this.#publish(node, error, view);
              view.requestMeasure();
              this.#ports.invalidateBackground?.();
            } catch (failure) {
              this.#ports.onError?.(failure);
            }
          } else this.#ports.onError?.(error);
        },
      );
    }
  }

  #renderContext(): TextMathRenderContext {
    return {
      fontSize: this.paint.fontSize,
      availableWidth: this.paint.availableWidth,
      bold: this.paint.bold ?? false,
      sourceRange: this.#sourceRange(),
      ...(this.paint.layout ? { layout: this.paint.layout } : {}),
    };
  }

  #publish(node: HTMLElement, result: MathPaint, _view: EditorView): void {
    node.removeAttribute("aria-busy");
    if (result instanceof TextMathSyntaxError) {
      this.#showLiteralSource(node);
      return;
    }
    node.classList.remove("inkbook-text-math-literal");
    node.setAttribute("role", "math");
    if (this.latex) node.setAttribute("aria-label", this.latex);
    const owned = node.ownerDocument.importNode(result, true);
    for (const [name, value] of Object.entries(this.paint.background))
      owned.setAttribute(name, value);
    node.replaceChildren(owned);
  }

  #sourceRange() {
    const range = { start: this.start, end: this.paint.end };
    return this.#ports.originalRange?.(range) ?? range;
  }

  #showLiteralSource(node: HTMLElement): void {
    node.classList.add("inkbook-text-math-literal");
    node.removeAttribute("role");
    node.removeAttribute("aria-label");
    const fragments: HTMLElement[] = [];
    for (const range of textFontFragments(this.start, this.paint.end, this.#ports)) {
      const span = node.ownerDocument.createElement("span");
      span.className = "cm-inline-code";
      for (const [name, value] of Object.entries(this.paint.background))
        span.setAttribute(name, value);
      span.setAttribute(
        "style",
        textStyleCss(
          this.paint.literalStyle,
          this.#ports.resolveFontResourceId?.(this.paint.literalStyle, range),
        ),
      );
      span.textContent = this.paint.source.sliceString(range.start, range.end);
      fragments.push(span);
    }
    node.replaceChildren(...fragments);
  }
}
