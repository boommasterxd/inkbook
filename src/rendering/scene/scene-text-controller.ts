import type { SceneContentRenderer } from "./content-renderer";
import type { SceneDom } from "./scene-dom";
import {
  createTextEditingSurface,
  type TextEditingCallbacks,
  type TextEditingSurface,
} from "./text-editing-surface";
import { SceneTextReadiness } from "./text-readiness";
import type { SceneCamera, SceneViewport } from "./types";
import { DEFAULT_CAMERA } from "./constants";
import { TextEditingDocumentAssets } from "./text-editing-document-assets";

/** Owns a single native editor and the document-local embedded font stylesheet. */
export class SceneTextController {
  #editing: TextEditingSurface | undefined;
  #style: SVGStyleElement | undefined;
  #released = false;
  #editingId: string | undefined;
  #viewport: SceneViewport | undefined;
  #camera: SceneCamera = DEFAULT_CAMERA;
  readonly #readiness = new SceneTextReadiness(
    () => this.context(),
    (id) => {
      if (id === this.#editingId) this.#editing?.dispose();
    },
    (id) => {
      if (id === this.#editingId) this.#editing?.syncGeometry?.();
    },
  );
  public readonly wait = this.#readiness.wait;
  public constructor(private readonly context: () => readonly [SceneDom, SceneContentRenderer]) {}

  /** Accepts canonical CSS generated from the document's validated font resources. */
  public readonly setFonts = (stylesheet: string): void => {
    if (this.#released) return;
    const [dom] = this.context();
    if (this.#style?.textContent === stylesheet) return;
    if (this.#style === undefined) {
      this.#style = dom.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "style");
      this.#style.setAttribute("id", "inkbook-fonts");
      dom.svg.prepend(this.#style);
    }
    this.#style.textContent = stylesheet;
  };

  public readonly begin = (
    id: string,
    callbacks: TextEditingCallbacks = {},
  ): TextEditingSurface | undefined => {
    if (this.#released) return undefined;
    this.#readiness.watch();
    const [dom, content] = this.context();
    const text = content.mountedText(id);
    if (text === undefined) return undefined;
    this.#editing?.dispose();
    this.#editingId = id;
    content.pinText(id);
    dom.setTextEditing(true);
    try {
      const editing = createTextEditingSurface(
        text,
        text.element,
        callbacks,
        () => {
          if (this.#editing !== editing) return;
          this.#editing = undefined;
          this.#editingId = undefined;
          content.pinText(undefined);
          dom.setTextEditing(false);
        },
        {
          cameraGroup: dom.cameraGroup,
          viewport: this.#viewport,
          camera: this.#camera,
          invalidate: () => dom.onSurfaceInvalidated(),
          prepareDocument: (document) =>
            new TextEditingDocumentAssets({
              document,
              source: dom.ownerDocument,
              stylesheet: () => this.#style?.textContent ?? "",
              releaseTheme: dom.attachTextDocument(document),
            }),
        },
      );
      this.#editing = editing;
      return editing;
    } catch (error) {
      this.#editing = undefined;
      this.#editingId = undefined;
      content.pinText(undefined);
      dom.setTextEditing(false);
      throw error;
    }
  };

  public updateViewport(viewport: SceneViewport | undefined, camera: SceneCamera): void {
    this.#viewport = viewport;
    this.#camera = camera;
    if (viewport !== undefined) this.#editing?.updateViewport(viewport, camera);
  }

  public release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#editing?.dispose();
    this.#readiness.release();
    this.#style?.remove();
    this.#style = undefined;
  }
}
