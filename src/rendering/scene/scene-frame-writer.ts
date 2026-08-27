import type { PageV1 } from "../../domain/schema/public";
import type { SceneBackgroundCache } from "./background-cache";
import {
  type AppliedLivePath,
  emptyAppliedLivePath,
  writeBackground,
  writeCamera,
  writeLivePath,
  writeOverlay,
  writeScheme,
} from "./frame-writes";
import type { SceneDom } from "./scene-dom";
import type { SceneTransformPreviewController } from "./transform-preview-controller";
import type {
  DocumentScheme,
  LivePathState,
  MutableSceneInstrumentation,
  SceneCamera,
} from "./types";

export class SceneFrameWriter {
  #appliedCamera = "";
  #appliedLivePath: AppliedLivePath = emptyAppliedLivePath();
  #appliedOverlayD = "";
  #appliedScheme: DocumentScheme | undefined;
  #backgroundD = "";
  #backgroundEdgeD = "";
  #backgroundKey: string | undefined;
  #camera: SceneCamera = { x: 0, zoom: 1 };
  #cameraDirty = true;
  readonly #backgroundCache: SceneBackgroundCache;
  readonly #dom: SceneDom;
  readonly #instrumentation: MutableSceneInstrumentation;
  #liveDirty = false;
  #livePath: LivePathState = { band: "content", parts: [] };
  #overlayDirty = false;
  #overlayPath = "";
  #pageHeight: number | undefined;
  #scheme: DocumentScheme = "light";
  #themeDirty = true;

  public constructor(
    dom: SceneDom,
    backgroundCache: SceneBackgroundCache,
    instrumentation: MutableSceneInstrumentation,
  ) {
    this.#dom = dom;
    this.#backgroundCache = backgroundCache;
    this.#instrumentation = instrumentation;
  }

  public setCamera(camera: SceneCamera): void {
    this.#camera = camera;
    this.#cameraDirty = true;
  }

  public setLivePath(path: LivePathState | null): void {
    this.#livePath = path ?? { band: "content", parts: [] };
    this.#liveDirty = true;
  }

  public setOverlayPath(path: string | null): boolean {
    const next = path ?? "";
    if (next === this.#overlayPath) return false;
    this.#overlayPath = next;
    this.#overlayDirty = true;
    return true;
  }

  public setScheme(scheme: DocumentScheme): void {
    this.#scheme = scheme;
    this.#themeDirty = true;
  }

  public writePointerFeedback(previews: SceneTransformPreviewController): void {
    if (this.#liveDirty) {
      this.#appliedLivePath = writeLivePath(
        this.#dom,
        this.#instrumentation,
        this.#livePath,
        this.#appliedLivePath,
      );
      this.#liveDirty = false;
    }
    if (this.#cameraDirty) {
      this.#appliedCamera = writeCamera(
        this.#dom,
        this.#instrumentation,
        this.#camera,
        this.#appliedCamera,
      );
      this.#cameraDirty = false;
    }
    if (this.#overlayDirty) {
      this.#appliedOverlayD = writeOverlay(
        this.#dom,
        this.#instrumentation,
        this.#overlayPath,
        this.#appliedOverlayD,
      );
      this.#overlayDirty = false;
    }
    if (this.#themeDirty && this.#scheme !== this.#appliedScheme) {
      writeScheme(this.#dom, this.#instrumentation, this.#scheme);
      this.#appliedScheme = this.#scheme;
    }
    this.#themeDirty = false;
    previews.write();
  }

  public writeBackground(page: PageV1, pageHeight: number, zoom: number): void {
    const applied = writeBackground({
      applied: {
        d: this.#backgroundD,
        edgeD: this.#backgroundEdgeD,
        key: this.#backgroundKey,
        pageHeight: this.#pageHeight,
      },
      cache: this.#backgroundCache,
      dom: this.#dom,
      instrumentation: this.#instrumentation,
      page,
      pageHeight,
      zoom,
    });
    this.#backgroundD = applied.d;
    this.#backgroundEdgeD = applied.edgeD;
    this.#backgroundKey = applied.key;
    this.#pageHeight = applied.pageHeight;
  }
}
