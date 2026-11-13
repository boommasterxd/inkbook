import { finishRenderMath, loadMathJax, renderMath } from "obsidian";

import type { FrameCancellation, WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { normalizeMathSvg } from "../../rendering/text/svg-math-normalizer";
import {
  assertTextLayoutActive,
  type ResolvedTextMath,
  type TextMathResolver,
  type TextMathStyle,
} from "../../rendering/text/text-layout-types";
import {
  assertTextMathInput,
  PortableMathRenderer,
  textMathSource,
} from "./portable-math-renderer";

/** Public host SVG is reused when available. CHTML uses the same local paths as saved SVG. */
export class ObsidianTextMathRenderer implements TextMathResolver {
  #portable: PortableMathRenderer | undefined;
  readonly #scheduler: WorkScheduler;
  #nativeSvg: boolean | undefined;
  #disposed = false;

  public constructor(scheduler: WorkScheduler) {
    this.#scheduler = scheduler;
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
    assertTextMathInput(latex, fontSize, availableWidth);
    if (this.#disposed) throw new Error("Math renderer disposed.");
    if (availableWidth === undefined && this.#nativeSvg !== false) {
      const native = await this.#resolveNative(
        textMathSource(latex, options),
        display,
        fontSize,
        signal,
      );
      if (native) return native;
    }
    this.#portable ??= new PortableMathRenderer(this.#scheduler);
    return this.#portable.resolve(latex, display, fontSize, signal, availableWidth, options);
  }

  public dispose(): void {
    this.#disposed = true;
    this.#portable?.dispose();
    this.#portable = undefined;
  }

  async #resolveNative(
    latex: string,
    display: boolean,
    fontSize: number,
    signal?: FrameCancellation,
  ): Promise<ResolvedTextMath | undefined> {
    let rendered: HTMLElement | undefined;
    try {
      await loadMathJax();
      assertTextLayoutActive(signal);
      if (this.#disposed) throw new Error("Math renderer disposed.");
      rendered = renderMath(latex, display);
      await finishRenderMath();
      assertTextLayoutActive(signal);
      if (this.#disposed) throw new Error("Math renderer disposed.");
      const svgs = rendered.querySelectorAll("svg");
      const svg = svgs.length === 1 ? svgs[0] : undefined;
      this.#nativeSvg = svg !== undefined;
      if (!svg) return undefined;
      return await normalizeMathSvg<Element>(
        svg,
        {
          kind: (node) => node.localName,
          attribute: (node, name) => node.getAttribute(name),
          children: (node) => Array.from(node.children),
        },
        fontSize,
        { scheduler: this.#scheduler, ...(signal ? { signal } : {}) },
      );
    } catch {
      assertTextLayoutActive(signal);
      if (this.#disposed) throw new Error("Math renderer disposed.");
      this.#nativeSvg = false;
      return undefined;
    } finally {
      rendered?.remove();
    }
  }
}
