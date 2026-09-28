import { SceneLivePathCommits } from "./live-path-commits";
import { SceneToolCursorWriter, type SceneToolCursorFrameReader } from "./tool-cursor";
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
import type { SceneElementPreviews } from "./scene-element-previews";
import type { SceneMotionController } from "./scene-motion-controller";
import type { SceneTransformPreviewController } from "./transform-preview-controller";
import type {
  DocumentScheme,
  LivePathState,
  MutableSceneInstrumentation,
  SceneCamera,
} from "./types";

export class SceneFrameWriter {
  public readonly livePathCommits: SceneLivePathCommits;
  public readonly toolCursor: SceneToolCursorWriter;
  #cursorLayoutDirty = true;
  #cursorReadPending = false;
  #cursorReader: SceneToolCursorFrameReader | undefined;
  #systemCursor: string | undefined;
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
  #pendingSelection:
    | {
        readonly fill: "accent" | "none";
        readonly handles: string | null;
        readonly path: string | null;
      }
    | undefined;
  #pendingSystemCursor: string | undefined;
  #pendingSnapPath: string | null | undefined;
  #scheme: DocumentScheme = "light";
  #themeDirty = true;

  public constructor(
    dom: SceneDom,
    backgroundCache: SceneBackgroundCache,
    instrumentation: MutableSceneInstrumentation,
  ) {
    this.livePathCommits = new SceneLivePathCommits(dom);
    this.toolCursor = new SceneToolCursorWriter(dom.toolCursor, instrumentation);
    this.#dom = dom;
    this.#backgroundCache = backgroundCache;
    this.#instrumentation = instrumentation;
  }

  public release(): void {
    this.#cursorReader = undefined;
    this.toolCursor.release();
    this.livePathCommits.settle(() => true);
  }

  public requestToolCursorFrame(read: SceneToolCursorFrameReader): void {
    this.#cursorReader = read;
    this.#cursorReadPending = true;
  }

  public moveToolCursor(x: number, y: number): void {
    if (!this.#cursorLayoutDirty) this.toolCursor.move(x, y);
  }

  public invalidateCursorLayout(): void {
    this.#cursorLayoutDirty = true;
  }

  public flushToolCursor(): void {
    this.readToolCursor();
    this.writeToolCursor();
  }

  public readToolCursor(refreshLayout = false): void {
    if (refreshLayout) this.invalidateCursorLayout();
    if (!this.#cursorLayoutDirty && !this.#cursorReadPending) return;
    const frame = this.#cursorReader?.(this.#cursorLayoutDirty);
    if (frame === undefined) return;
    this.#cursorLayoutDirty = false;
    this.#cursorReadPending = false;
    this.toolCursor.set(frame.cursor);
    this.#pendingSystemCursor = frame.system;
  }

  public writeToolCursor(): void {
    if (
      this.#pendingSystemCursor !== undefined &&
      this.#pendingSystemCursor !== this.#systemCursor
    ) {
      this.#dom.inputSurface.style.setProperty("cursor", this.#pendingSystemCursor);
      this.#systemCursor = this.#pendingSystemCursor;
      this.#instrumentation.attributeWrites += 1;
    }
    this.toolCursor.write();
  }

  public commitLivePath(id: string): void {
    this.livePathCommits.assertAvailable(id);
    this.writeLivePath();
    this.livePathCommits.retain(id, this.#appliedLivePath);
    this.#appliedLivePath = emptyAppliedLivePath();
    this.#livePath = { band: "content", parts: [] };
  }

  private writeLivePath(): void {
    if (this.#liveDirty) {
      this.#appliedLivePath = writeLivePath(
        this.#dom,
        this.#instrumentation,
        this.#livePath,
        this.#appliedLivePath,
      );
      this.#liveDirty = false;
    }
  }

  public setCamera(camera: SceneCamera): void {
    this.#camera = camera;
    this.invalidateCursorLayout();
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

  public setSelectionPath(
    path: string | null,
    handles: string | null,
    fill: "accent" | "none",
  ): void {
    this.#pendingSelection = { fill, handles, path };
  }

  public setSnapPath(path: string | null): void {
    this.#pendingSnapPath = path;
  }

  public setScheme(scheme: DocumentScheme): void {
    this.#scheme = scheme;
    this.#themeDirty = true;
  }

  public writePointerFeedback(
    transforms: SceneTransformPreviewController,
    elements: SceneElementPreviews,
    motion: SceneMotionController,
    deadline: number,
    now: () => number,
  ): void {
    this.writeLivePath();
    this.writeToolCursor();
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
    elements.immediate.write();
    transforms.write();
    elements.progressive.writeFeedback(this.#camera.zoom, deadline, now);
    const selection = this.#pendingSelection;
    if (selection !== undefined) {
      this.#pendingSelection = undefined;
      motion.applySelectionPath(selection.path, selection.handles, selection.fill);
    }
    if (this.#pendingSnapPath !== undefined) {
      const snap = this.#pendingSnapPath;
      this.#pendingSnapPath = undefined;
      motion.applySnapPath(snap);
    }
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
