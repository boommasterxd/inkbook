import type { EditorView } from "@codemirror/view";
import type { ColorV1, TextRangeStyleV2 } from "../../../domain/schema/public";
import {
  appendTextBackgroundPaint,
  type TextBackgroundPaint,
} from "../../../domain/geometry/text-backgrounds";
import {
  roundedBackgroundIntersection,
  textBackgroundBoxPath,
} from "../../../domain/geometry/rounded-background-path";
import { TextEditorReadiness } from "./text-editor-readiness";
import {
  measureTextBackground,
  type TextEditorBackgroundBase,
} from "./text-background-measurement";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
export type { TextEditorBackgroundBase } from "./text-background-measurement";

/** Decoration metadata is paint-only: native CSS never composites a second background. */
export function textBackgroundAttributes(style: TextRangeStyleV2): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (style.backgroundColor !== undefined)
    attributes["data-inkbook-bg-color"] =
      style.backgroundColor === null
        ? "none"
        : style.backgroundColor.type === "theme-text"
          ? "theme-text"
          : style.backgroundColor.value;
  if (style.backgroundOpacity !== undefined)
    attributes["data-inkbook-bg-opacity"] = String(style.backgroundOpacity);
  if (Object.keys(attributes).length) attributes["data-inkbook-text-background"] = "";
  return attributes;
}

/** One owned, viewport-measured background layer replaces the saved field paint during input. */
export class TextEditorBackgroundLayer {
  readonly #readiness = new TextEditorReadiness();
  public readonly ready = this.#readiness.ready;
  readonly #svg: SVGSVGElement;
  readonly #definitions: SVGDefsElement;
  readonly #mask: SVGMaskElement;
  readonly #maskBox: SVGRectElement;
  readonly #cutouts: SVGPathElement;
  readonly #paths: SVGPathElement[] = [];
  readonly #hadBackgroundClass: boolean;
  #measurePending = false;
  #generation = 0;
  #publishedGeneration = -1;
  #disposed = false;

  public constructor(
    private readonly view: EditorView,
    private readonly base: () => TextEditorBackgroundBase,
    private readonly onError?: (error: unknown) => void,
  ) {
    this.#svg = view.dom.ownerDocument.createElementNS(SVG_NAMESPACE, "svg");
    this.#svg.setAttribute("class", "inkbook-text-editor-background");
    this.#svg.setAttribute("aria-hidden", "true");
    this.#svg.setAttribute("focusable", "false");
    const document = view.dom.ownerDocument;
    this.#definitions = document.createElementNS(SVG_NAMESPACE, "defs");
    this.#mask = document.createElementNS(SVG_NAMESPACE, "mask");
    this.#mask.id = `inkbook-text-background-${document.defaultView!.crypto.randomUUID()}`;
    this.#mask.setAttribute("maskUnits", "userSpaceOnUse");
    this.#mask.setAttribute("maskContentUnits", "userSpaceOnUse");
    this.#mask.setAttribute("mask-type", "luminance");
    this.#maskBox = document.createElementNS(SVG_NAMESPACE, "rect");
    this.#maskBox.setAttribute("fill", "white");
    this.#cutouts = document.createElementNS(SVG_NAMESPACE, "path");
    this.#cutouts.setAttribute("fill", "black");
    this.#cutouts.setAttribute("fill-rule", "nonzero");
    this.#mask.append(this.#maskBox, this.#cutouts);
    this.#definitions.append(this.#mask);
    this.#svg.append(this.#definitions);
    this.#hadBackgroundClass = view.dom.classList.contains("inkbook-text-background-owner");
    view.dom.classList.add("inkbook-text-background-owner");
    view.dom.prepend(this.#svg);
    this.invalidate();
  }

  public invalidate(): void {
    if (this.#disposed) return;
    this.#generation += 1;
    if (!this.#measurePending) this.#measure();
  }

  /** Geometry already owns this immediate read after its matching native bounds. */
  public publishGeometry(style?: CSSStyleDeclaration): void {
    if (this.#disposed) return;
    try {
      const measured = measureTextBackground(this.view, this.base(), style);
      if (measured) this.#publish(measured, this.#generation);
    } catch (error) {
      this.#fail(error);
    }
  }

  #measure(): void {
    if (this.#disposed) return;
    let generation = this.#generation;
    this.#measurePending = true;
    this.view.requestMeasure({
      key: this,
      read: () => {
        try {
          generation = this.#generation;
          return this.#disposed || generation === this.#publishedGeneration
            ? undefined
            : measureTextBackground(this.view, this.base());
        } catch (error) {
          this.#fail(error);
          return undefined;
        }
      },
      write: (measured) => {
        this.#measurePending = false;
        if (this.#disposed) return;
        if (generation !== this.#generation) {
          this.invalidate();
          return;
        }
        if (measured && generation !== this.#publishedGeneration)
          this.#publish(measured, generation);
      },
    });
  }

  #publish(
    measured: NonNullable<ReturnType<typeof measureTextBackground>>,
    generation: number,
  ): void {
    const groups = new Map<string, TextBackgroundPaint>();
    let cutouts = "";
    for (const rectangle of measured.rectangles) {
      const d = roundedBackgroundIntersection(measured.box, rectangle, measured.radius);
      cutouts += d;
      appendTextBackgroundPaint(groups, rectangle, d);
    }
    for (const [name, value] of Object.entries(measured.box)) {
      write(this.#mask, name, String(value));
      write(this.#maskBox, name, String(value));
    }
    write(this.#cutouts, "d", cutouts);
    const paints = [...groups.values()];
    const base = measured.base.color !== null && measured.base.opacity > 0;
    if (base)
      paints.unshift({
        color: measured.base.color!,
        opacity: measured.base.opacity,
        d: textBackgroundBoxPath(measured.box, measured.radius),
      });
    this.#paint(paints, base && cutouts.length > 0);
    this.#publishedGeneration = generation;
    this.#readiness.resolve();
  }

  #fail(error: unknown): void {
    if (this.#disposed) return;
    this.#readiness.reject(error);
    this.onError?.(error);
  }

  #paint(paints: readonly TextBackgroundPaint[], maskedBase: boolean): void {
    for (let index = 0; index < paints.length; index += 1) {
      let path = this.#paths[index];
      if (!path) {
        path = this.#svg.ownerDocument.createElementNS(SVG_NAMESPACE, "path");
        path.setAttribute("fill-rule", "nonzero");
        this.#paths.push(path);
        this.#svg.insertBefore(path, this.#definitions);
      }
      const paint = paints[index]!;
      write(path, "d", paint.d);
      write(path, "fill", backgroundColor(paint.color));
      write(path, "fill-opacity", String(paint.opacity));
      if (index === 0 && maskedBase) write(path, "mask", `url(#${this.#mask.id})`);
      else path.removeAttribute("mask");
    }
    for (const path of this.#paths.splice(paints.length)) path.remove();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#svg.remove();
    this.#paths.length = 0;
    if (!this.#hadBackgroundClass) this.view.dom.classList.remove("inkbook-text-background-owner");
    this.#readiness.resolve();
  }
}

function backgroundColor(color: ColorV1): string {
  return color.type === "rgba" ? color.value : "var(--inkbook-text-color, #222222FF)";
}

function write(node: Element, name: string, value: string): void {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}
