import { configureSceneDocument, createSceneFrame } from "./scene-surface-document";

const themeProperties = [
  "--interactive-accent",
  "--text-normal",
  "--inkbook-scene-foreground-visibility",
] as const;

interface SceneSurfaceOptions {
  readonly themeRoot?: HTMLElement;
  readonly onFailure?: () => void;
}

interface OwnZoomStyle {
  readonly before: string | null;
  after: string | null;
  writes: number;
  consistent: boolean;
}

/** Owns one decorative document outside the host document's style invalidation tree. */
export class SceneSurface {
  public readonly host: HTMLDivElement;
  public readonly drawingDocument: Document;
  readonly #frame: HTMLIFrameElement;
  readonly #frameStyle: HTMLStyleElement;
  readonly #documentStyle: HTMLStyleElement;
  readonly #onInvalidate: (themeChanged?: boolean) => void;
  readonly #onFailure: (() => void) | undefined;
  readonly #resizeObserver: ResizeObserver | undefined;
  readonly #themeObserver: MutationObserver | undefined;
  readonly #container: HTMLElement;
  readonly #load: () => void;
  readonly #tokens = new Map<string, string>();
  readonly #writtenTokens = new Map<string, string>();
  #svg: SVGSVGElement | undefined;
  #ownZoomStyle: OwnZoomStyle | undefined;
  #themeDirty = true;
  #released = false;
  #width = "0px";
  #height = "0px";
  #writtenWidth = "";
  #writtenHeight = "";

  public constructor(
    container: HTMLElement,
    onInvalidate: (themeChanged?: boolean) => void,
    options: SceneSurfaceOptions = {},
  ) {
    this.#onInvalidate = onInvalidate;
    this.#container = container;
    this.#onFailure = options.onFailure;
    const ownerDocument = container.ownerDocument;
    this.host = ownerDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    this.host.setAttribute("class", "inkbook-scene");
    this.host.setAttribute("aria-hidden", "true");
    const { frame, style } = createSceneFrame(ownerDocument);
    this.#frame = frame;
    this.#frameStyle = style;
    this.host.attachShadow({ mode: "open" }).append(style, this.#frame);
    container.append(this.host);
    const drawingDocument = this.#frame.contentDocument;
    if (drawingDocument?.body === undefined || drawingDocument.body === null) {
      this.#frame.remove();
      this.#frameStyle.remove();
      this.host.remove();
      throw new Error("The scene surface requires an attached presentation document.");
    }
    this.drawingDocument = drawingDocument;
    this.#documentStyle = configureSceneDocument(this.drawingDocument);
    this.#load = () => this.handleLoad();
    this.#frame.addEventListener("load", this.#load);
    const ownerWindow = ownerDocument.defaultView;
    this.#resizeObserver = ownerWindow?.ResizeObserver
      ? new ownerWindow.ResizeObserver((entries) => this.resize(entries))
      : undefined;
    this.#resizeObserver?.observe(this.host);
    this.#themeObserver = ownerWindow?.MutationObserver
      ? new ownerWindow.MutationObserver((records) => this.observeTheme(records))
      : undefined;
    const targets = new Set([
      container,
      options.themeRoot ?? container,
      ownerDocument.body,
      ownerDocument.documentElement,
    ]);
    for (const target of targets) {
      if (target !== null) {
        this.#themeObserver?.observe(target, {
          attributes: true,
          attributeOldValue: true,
          attributeFilter: ["class", "style"],
        });
      }
    }
    this.readInitialSize();
    this.write();
  }

  public attach(svg: SVGSVGElement): void {
    if (this.#released) return;
    if (svg.ownerDocument !== this.drawingDocument) {
      throw new Error("Scene nodes must be created in the drawing document.");
    }
    this.#svg = svg;
    this.drawingDocument.body.append(svg);
  }

  /** Zoom height is a layout signal; only this owned write can bypass a theme read. */
  public setZoomBlockSize(blockSize: number): void {
    if (this.#released || !Number.isFinite(blockSize) || blockSize < 0) return;
    const value = `${String(blockSize)}px`;
    if (this.#container.style.blockSize === value) return;
    const before = this.#container.getAttribute("style");
    this.#container.style.blockSize = value;
    const after = this.#container.getAttribute("style");
    if (this.#themeObserver === undefined || before === after) return;
    const pending = this.#ownZoomStyle;
    this.#ownZoomStyle = {
      before: pending === undefined ? before : pending.before,
      after,
      writes: (pending?.writes ?? 0) + 1,
      consistent:
        (pending?.consistent ?? true) && (pending === undefined || pending.after === before),
    };
  }

  /** All host style reads precede the central frame's scene writes. */
  public read(): void {
    if (!this.#themeDirty || this.#released) return;
    this.#themeDirty = false;
    const style = this.host.ownerDocument.defaultView?.getComputedStyle(this.host);
    this.captureTheme(style);
  }

  public write(): void {
    if (this.#released) return;
    const body = this.drawingDocument.body;
    if (this.#writtenWidth !== this.#width) {
      body.style.setProperty("width", this.#width);
      this.#writtenWidth = this.#width;
    }
    if (this.#writtenHeight !== this.#height) {
      body.style.setProperty("height", this.#height);
      this.#writtenHeight = this.#height;
    }
    for (const [property, value] of this.#tokens) {
      if (this.#writtenTokens.get(property) === value) continue;
      body.style.setProperty(property, value);
      this.#writtenTokens.set(property, value);
    }
  }

  public invalidateTheme(): void {
    if (this.#released) return;
    this.#themeDirty = true;
    this.#onInvalidate(true);
  }

  public reveal(): void {
    if (this.#released) return;
    this.#tokens.set("--inkbook-scene-foreground-visibility", "visible");
    this.write();
  }

  public release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#resizeObserver?.disconnect();
    this.#themeObserver?.disconnect();
    this.#ownZoomStyle = undefined;
    this.#frame.removeEventListener("load", this.#load);
    this.#svg?.remove();
    this.#documentStyle.remove();
    this.#frame.remove();
    this.#frameStyle.remove();
    this.host.remove();
  }

  private resize(entries: readonly ResizeObserverEntry[]): void {
    if (this.#released) return;
    const entry = entries.find(({ target }) => target === this.host);
    if (entry === undefined) return;
    const width = `${String(entry.contentRect.width)}px`;
    const height = `${String(entry.contentRect.height)}px`;
    if (width === this.#width && height === this.#height) return;
    this.#width = width;
    this.#height = height;
    this.#onInvalidate();
  }

  private observeTheme(records: readonly MutationRecord[]): void {
    const pending = this.#ownZoomStyle;
    this.#ownZoomStyle = undefined;
    if (
      pending?.consistent === true &&
      records.length === pending.writes &&
      records[0]?.oldValue === pending.before &&
      this.#container.getAttribute("style") === pending.after &&
      records.every(
        (record) =>
          record.type === "attributes" &&
          record.target === this.#container &&
          record.attributeName === "style",
      )
    )
      return;
    this.invalidateTheme();
  }

  private readInitialSize(): void {
    const style = this.host.ownerDocument.defaultView?.getComputedStyle(this.host);
    if (style === undefined) return;
    const width = Number.parseFloat(style.width);
    const height = Number.parseFloat(style.height);
    if (Number.isFinite(width) && style.width.endsWith("px")) this.#width = `${String(width)}px`;
    if (Number.isFinite(height) && style.height.endsWith("px"))
      this.#height = `${String(height)}px`;
    this.captureTheme(style);
    this.#themeDirty = false;
  }

  private captureTheme(style: CSSStyleDeclaration | undefined): void {
    for (const property of themeProperties) {
      this.#tokens.set(property, style?.getPropertyValue(property).trim() ?? "");
    }
  }

  private handleLoad(): void {
    if (this.#released) return;
    // The initial about:blank load keeps the attached SVG and cached document.
    if (this.#frame.contentDocument !== this.drawingDocument) {
      this.release();
      this.#onFailure?.();
      return;
    }
    this.invalidateTheme();
  }
}
