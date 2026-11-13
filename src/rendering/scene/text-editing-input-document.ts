import {
  configureSceneDocument,
  createSceneFrame,
  type SceneDocumentAssets,
} from "./scene-surface-document";
import { SCENE_SURFACE_STYLES } from "./scene-surface-styles";
import { SVG_NAMESPACE } from "./constants";

/** Owns one unrotated native editing document inside the existing source viewport. */
export class TextEditingInputDocument {
  public readonly container: HTMLDivElement;
  public readonly document: Document;
  public readonly ready: Promise<void>;
  public readonly node: SVGForeignObjectElement;
  public readonly clip: HTMLDivElement;
  readonly #frame: HTMLIFrameElement;
  readonly #style: HTMLStyleElement;
  readonly #assets: SceneDocumentAssets | undefined;
  #disposed = false;
  #invalidated = false;

  public constructor(
    private readonly options: {
      readonly group: SVGGElement;
      readonly prepareDocument?: ((document: Document) => SceneDocumentAssets) | undefined;
      readonly onInvalidated: () => void;
    },
  ) {
    const ownerDocument = options.group.ownerDocument;
    const node = ownerDocument.createElementNS(SVG_NAMESPACE, "foreignObject");
    this.node = node;
    this.clip = ownerDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    this.clip.setAttribute("class", "inkbook-text-editor-viewport");
    node.setAttribute("pointer-events", "auto");
    node.setAttribute("overflow", "visible");
    node.setAttribute("visibility", "hidden");
    node.append(this.clip);
    options.group.append(node);
    const { frame, style } = createSceneFrame(ownerDocument);
    this.#frame = frame;
    this.#style = style;
    frame.setAttribute("class", "inkbook-scene-frame inkbook-text-input-frame");
    frame.setAttribute("title", "Text");
    frame.removeAttribute("aria-hidden");
    frame.removeAttribute("inert");
    frame.removeAttribute("tabindex");
    style.textContent += ".inkbook-text-input-frame { pointer-events: auto; }";
    this.clip.append(style, frame);
    const document = frame.contentDocument;
    if (!document) {
      this.dispose();
      throw new Error("Text input document unavailable.");
    }
    this.document = document;
    configureSceneDocument(document);
    const language = ownerDocument.documentElement.getAttribute("lang");
    if (language) document.documentElement.setAttribute("lang", language);
    const inputStyle = document.createElementNS("http://www.w3.org/1999/xhtml", "style");
    inputStyle.textContent = `${SCENE_SURFACE_STYLES}
      html { height: 100%; overflow: clip; }
      body { position: fixed; inset: 0; width: 100%; height: 100%; overflow: clip; }
    `;
    document.head.append(inputStyle);
    this.container = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    this.container.setAttribute("class", "inkbook-text-editor");
    document.body.append(this.container);
    try {
      this.#assets = options.prepareDocument?.(document);
    } catch (error) {
      this.dispose();
      throw error;
    }
    frame.addEventListener("load", this.#load);
    this.ready = (this.#assets?.ready ?? Promise.resolve()).then(() => {
      if (!this.#disposed && !this.valid) throw new Error("Text input document replaced.");
    });
    void this.ready.catch(() => undefined);
  }

  public get valid(): boolean {
    return !this.#disposed && !this.#invalidated && this.#frame.contentDocument === this.document;
  }
  public prepare(): Promise<void> {
    return this.#assets?.prepare() ?? Promise.resolve();
  }
  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#frame.removeEventListener("load", this.#load);
    this.#assets?.dispose();
    this.#frame.remove();
    this.#style.remove();
    this.node.remove();
  }
  readonly #load = (): void => {
    if (this.#disposed || this.#invalidated || this.#frame.contentDocument === this.document)
      return;
    this.#invalidated = true;
    this.node.setAttribute("visibility", "hidden");
    this.options.onInvalidated();
  };
}
