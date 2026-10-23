import { configureSceneDocument, createSceneFrame } from "./scene-surface-document";
import { STATIC_PREVIEW_STYLES } from "./static-preview-styles";

/** Retains one already validated static SVG across presentation document transfers. */
export class StaticPreviewSurface {
  readonly #frame: HTMLIFrameElement;
  readonly #frameStyle: HTMLStyleElement;
  readonly #waiters = new Set<(error?: Error) => void>();
  #document: Document | undefined;
  #documentStyle: HTMLStyleElement | undefined;
  #scheme: "light" | "dark" = "light";
  #svg: SVGSVGElement | undefined;
  #disposed = false;

  public constructor(container: HTMLElement) {
    const { frame, style } = createSceneFrame(container.ownerDocument);
    this.#frame = frame;
    this.#frameStyle = style;
    style.textContent += `
      :host { position: relative; }
      .inkbook-scene-frame { position: absolute; inset: 0; }
    `;
    frame.addEventListener("load", this.#handleLoad);
    container.attachShadow({ mode: "open" }).append(style, frame);
    this.refresh();
  }

  public get drawingDocument(): Document | undefined {
    if (this.#disposed || !this.#frame.isConnected) return undefined;
    if (this.#frame.ownerDocument.defaultView?.closed === true) return undefined;
    const document = this.#frame.contentDocument;
    return document?.body === null || document?.body === undefined ? undefined : document;
  }

  public refresh(): void {
    if (this.#disposed) return;
    if (this.#frame.ownerDocument.defaultView?.closed === true) {
      this.dispose();
      return;
    }
    const document = this.drawingDocument;
    if (document === undefined) return;
    if (document !== this.#document) this.#configure(document);
    this.#applyScheme(document);
    const svg = this.#svg;
    if (svg === undefined) return;
    if (svg.ownerDocument !== document) document.adoptNode(svg);
    if (svg.parentNode !== document.body) document.body.replaceChildren(svg);
    for (const finish of this.#waiters) finish();
  }

  public setSvg(svg: SVGSVGElement): void {
    if (this.#disposed) return;
    if (svg !== this.#svg) this.#svg?.remove();
    this.#svg = svg;
    this.refresh();
  }

  public setColorScheme(scheme: "light" | "dark"): void {
    if (this.#disposed || scheme === this.#scheme) return;
    this.#scheme = scheme;
    this.refresh();
  }

  public async ensureMounted(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.refresh();
    if (this.#disposed) throw new Error("The Inkbook preview surface is disposed.");
    if (this.#svg?.parentNode === this.drawingDocument?.body && this.#svg !== undefined) return;
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        this.#waiters.delete(finish);
        signal?.removeEventListener("abort", onAbort);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onAbort = (): void => {
        const reason: unknown = signal?.reason;
        finish(reason instanceof Error ? reason : new Error("Inkbook preview mounting aborted."));
      };
      this.#waiters.add(finish);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#frame.removeEventListener("load", this.#handleLoad);
    this.#svg?.remove();
    this.#svg = undefined;
    this.#releaseStyles();
    this.#document = undefined;
    this.#frame.remove();
    this.#frameStyle.remove();
    for (const finish of this.#waiters)
      finish(new Error("The Inkbook preview surface is disposed."));
  }

  #configure(document: Document): void {
    this.#releaseStyles();
    const style = configureSceneDocument(document);
    style.textContent += STATIC_PREVIEW_STYLES;
    this.#documentStyle = style;
    this.#document = document;
  }

  #applyScheme(document: Document): void {
    const root = document.documentElement;
    if (root.dataset.inkbookScheme !== this.#scheme) root.dataset.inkbookScheme = this.#scheme;
  }

  #releaseStyles(): void {
    this.#documentStyle?.remove();
    this.#documentStyle = undefined;
  }

  readonly #handleLoad = (): void => this.refresh();
}
