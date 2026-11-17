import { finishRenderMath, loadMathJax, renderMath } from "obsidian";

import type { FrameCancellation, WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { normalizeMathSvg } from "../../rendering/text/svg-math-normalizer";
import {
  assertTextLayoutActive,
  type ResolvedTextMath,
  type TextMathResolver,
  type TextMathStyle,
} from "../../rendering/text/text-layout-types";
import { assertTextMathInput, textMathSource } from "./math-input";
import {
  portableMathLoader,
  type PortableMathEngine,
  type PortableMathModuleLoader,
} from "./portable-math-loader";

/** Public host SVG is reused when available. CHTML uses the same local paths as saved SVG. */
export class ObsidianTextMathRenderer implements TextMathResolver {
  #portable: PortableMathEngine | undefined;
  readonly #loader: PortableMathModuleLoader;
  readonly #lifetime = new AbortController();
  readonly #scheduler: WorkScheduler;
  #nativeSvg: boolean | undefined;
  #disposed = false;

  public constructor(
    scheduler: WorkScheduler,
    loader: PortableMathModuleLoader = portableMathLoader,
  ) {
    this.#scheduler = scheduler;
    this.#loader = loader;
  }

  /** Known formula source may prepare code while independent font work proceeds. */
  public async prepare(signal?: FrameCancellation): Promise<boolean> {
    if (this.#disposed) return false;
    try {
      assertTextLayoutActive(signal);
      await this.#loadModule(signal);
      return !this.#disposed;
    } catch {
      return false;
    }
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
    if (this.#portable === undefined) {
      const module = await this.#loadModule(signal);
      assertTextLayoutActive(signal);
      if (this.#disposed) throw new Error("Math renderer disposed.");
      this.#portable ??= module.createPortableMathRenderer(this.#scheduler);
    }
    return this.#portable.resolve(latex, display, fontSize, signal, availableWidth, options);
  }

  public dispose(): void {
    this.#disposed = true;
    this.#lifetime.abort(new Error("Math renderer disposed."));
    this.#portable?.dispose();
    this.#portable = undefined;
  }

  async #loadModule(signal?: FrameCancellation) {
    const lease = this.#loader.acquire();
    let cancel = (): void => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => {
        const reason: unknown = signal?.aborted ? signal.reason : this.#lifetime.signal.reason;
        reject(reason instanceof Error ? reason : new Error("Text layout cancelled."));
      };
      this.#lifetime.signal.addEventListener("abort", cancel, { once: true });
      signal?.addEventListener("abort", cancel, { once: true });
      if (this.#lifetime.signal.aborted || signal?.aborted) cancel();
    });
    try {
      return await Promise.race([lease.module, cancelled]);
    } finally {
      this.#lifetime.signal.removeEventListener("abort", cancel);
      signal?.removeEventListener("abort", cancel);
      lease.release();
    }
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
