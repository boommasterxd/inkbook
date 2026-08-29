import type { InkbookDeviceSettingsV1 } from "../../domain/settings/types";
import { TRANSITION_DURATIONS } from "../../rendering/motion/transitions";

type MotionPreference = InkbookDeviceSettingsV1["motion"];

const ACTIVE_SCENE_BLOCK_SIZE_PROPERTY = "--inkbook-active-scene-block-size";
const LOCKED_CONTAINER_BLOCK_SIZE_PROPERTY = "--inkbook-locked-container-block-size";

interface PreviewHandoffOptions {
  readonly beginScrollStability?: () => () => void;
  readonly container: HTMLElement;
  readonly initialScrollStabilityRelease?: () => void;
  readonly motion: MotionPreference;
  readonly preview: HTMLElement | undefined;
  readonly setPreviewAspectRatio?: (aspectRatio: number) => void;
  readonly setPreviewSource?: (source: string) => Promise<void>;
  readonly root: HTMLElement;
}

export class ActiveScenePreviewHandoff {
  readonly #beginScrollStability: (() => () => void) | undefined;
  readonly #container: HTMLElement;
  readonly #mediaQuery: MediaQueryList | undefined;
  #motion: MotionPreference;
  readonly #ownerWindow: Window;
  readonly #preview: HTMLElement | undefined;
  readonly #previewNextSibling: ChildNode | null;
  readonly #previewParent: Node | null;
  readonly #root: HTMLElement;
  readonly #setPreviewAspectRatio: ((aspectRatio: number) => void) | undefined;
  readonly #setPreviewSource: ((source: string) => Promise<void>) | undefined;
  readonly #lockedBlockSize: string;
  #disposed = false;
  #onReady: (() => void) | undefined;
  #onLockComplete: (() => void) | undefined;
  #lockEditor: HTMLElement | undefined;
  #releaseScrollStability: (() => void) | undefined;
  #started = false;
  #timer: number | undefined;
  #frame: number | undefined;

  public constructor(options: PreviewHandoffOptions) {
    const ownerWindow = options.root.ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("The preview handoff requires an owning window.");
    this.#beginScrollStability = options.beginScrollStability;
    this.#container = options.container;
    this.#motion = options.motion;
    this.#ownerWindow = ownerWindow;
    this.#preview = options.preview;
    this.#setPreviewAspectRatio = options.setPreviewAspectRatio;
    this.#setPreviewSource = options.setPreviewSource;
    this.#previewNextSibling = options.preview?.nextSibling ?? null;
    this.#previewParent = options.preview?.parentNode ?? null;
    this.#root = options.root;
    this.#releaseScrollStability = options.initialScrollStabilityRelease;
    this.#mediaQuery = ownerWindow.matchMedia?.("(prefers-reduced-motion: reduce)");
    this.#mediaQuery?.addEventListener("change", this.#handleMotionChange);
    this.#root.classList.add("inkbook-active-preparing");
    this.#preview?.classList.add("inkbook-preview-handoff");
    const lockedHeight = this.#preview?.getBoundingClientRect().height ?? 0;
    this.#lockedBlockSize = lockedHeight > 0 ? `${String(lockedHeight)}px` : "";
    if (this.#lockedBlockSize !== "") {
      this.#container.style.blockSize = this.#lockedBlockSize;
      this.#container.style.setProperty(
        LOCKED_CONTAINER_BLOCK_SIZE_PROPERTY,
        this.#lockedBlockSize,
      );
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#onReady = undefined;
    this.#clearTimer();
    this.#releaseTransitionStability();
    if (this.#frame !== undefined) this.#ownerWindow.cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
    this.#mediaQuery?.removeEventListener("change", this.#handleMotionChange);
    const onLockComplete = this.#onLockComplete;
    this.#onLockComplete = undefined;
    this.#lockEditor = undefined;
    onLockComplete?.();
    this.#root.classList.remove(
      "inkbook-active-preparing",
      "inkbook-active-transitioning",
      "inkbook-active-ready",
    );
    this.#container.style.removeProperty(ACTIVE_SCENE_BLOCK_SIZE_PROPERTY);
    this.#container.style.removeProperty(LOCKED_CONTAINER_BLOCK_SIZE_PROPERTY);
    this.#preview?.classList.remove("inkbook-preview-handoff");
    this.#resetPreviewLayer();
    this.#resetEditorLayer(this.#lockEditor);
    this.restorePreview();
  }

  public ready(onReady?: () => void): void {
    if (this.#disposed || this.#started || this.#root.classList.contains("inkbook-active-ready")) {
      return;
    }
    this.#onReady = onReady;
    this.#started = true;
    const activeBlockSize = this.#container.style.blockSize;
    if (activeBlockSize !== "") {
      this.#container.style.setProperty(ACTIVE_SCENE_BLOCK_SIZE_PROPERTY, activeBlockSize);
    }
    this.#container.getBoundingClientRect();
    if (this.#reducedMotion()) {
      this.#startUnlockTransition(activeBlockSize);
      this.#complete();
      return;
    }
    this.#scheduleUnlockTransition(activeBlockSize);
  }

  #scheduleUnlockTransition(activeBlockSize: string): void {
    this.#scheduleAfterPaint(() => this.#startUnlockTransition(activeBlockSize));
  }

  #scheduleAfterPaint(callback: () => void): void {
    this.#frame = this.#ownerWindow.requestAnimationFrame(() => {
      this.#frame = undefined;
      if (this.#disposed) return;
      this.#frame = this.#ownerWindow.requestAnimationFrame(() => {
        this.#frame = undefined;
        if (this.#disposed) return;
        callback();
      });
    });
  }

  #startUnlockTransition(activeBlockSize: string): void {
    this.#releaseScrollStability ??= this.#beginScrollStability?.();
    if (this.#preview !== undefined) this.#preview.hidden = true;
    this.#root.classList.remove("inkbook-active-preparing");
    this.#root.classList.add("inkbook-active-transitioning");
    this.#container.style.blockSize = activeBlockSize;
    this.#notifyReady();
    this.#timer = this.#ownerWindow.setTimeout(
      () => this.#complete(),
      TRANSITION_DURATIONS.lockedToActiveHeight,
    );
  }

  public restorePreview(): void {
    const preview = this.#preview;
    if (preview === undefined) return;
    if (!preview.isConnected && this.#previewParent !== null) {
      if (this.#previewNextSibling?.parentNode === this.#previewParent) {
        this.#previewParent.insertBefore(preview, this.#previewNextSibling);
      } else {
        this.#previewParent.appendChild(preview);
      }
    }
    preview.hidden = false;
  }

  public get reducedMotion(): boolean {
    return this.#reducedMotion();
  }

  public updateMotion(motion: MotionPreference): void {
    this.#motion = motion;
    if (this.#reducedMotion()) this.#finishReducedMotion();
  }

  public setPreviewSource(source: string): Promise<void> {
    const preview = this.#preview;
    if (preview === undefined) return Promise.resolve();
    if (this.#setPreviewSource !== undefined) {
      return this.#setPreviewSource(source);
    }
    if (preview.tagName !== "IMG") return Promise.resolve();
    const image = preview as HTMLImageElement;
    image.src = source;
    return typeof image.decode === "function"
      ? image.decode().catch(() => undefined)
      : Promise.resolve();
  }

  public setPreviewAspectRatio(aspectRatio: number): void {
    this.#setPreviewAspectRatio?.(aspectRatio);
  }

  public handoffToPreview(
    editorChrome: HTMLElement,
    onComplete: () => void,
    finalizeLayout: () => void = () => undefined,
  ): void {
    if (this.#disposed) return;
    finalizeLayout();
    this.restorePreview();
    const preview = this.#preview;
    if (preview === undefined) {
      onComplete();
      return;
    }
    if (this.#reducedMotion()) {
      editorChrome.hidden = true;
      onComplete();
      return;
    }
    this.#onLockComplete = onComplete;
    this.#lockEditor = editorChrome;
    preview.classList.add("inkbook-preview-handoff");
    preview.setCssProps({
      inset: "0",
      position: "absolute",
      zIndex: "1",
    });
    editorChrome.setCssProps({
      zIndex: "2",
    });
    this.#scheduleAfterPaint(() => {
      this.#resetPreviewLayer();
      editorChrome.hidden = true;
      this.#resetEditorLayer(editorChrome);
      const complete = this.#onLockComplete;
      this.#onLockComplete = undefined;
      this.#lockEditor = undefined;
      complete?.();
    });
  }

  readonly #handleMotionChange = (): void => {
    if (this.#motion === "system" && this.#mediaQuery?.matches === true) {
      this.#finishReducedMotion();
    }
  };

  #finishReducedMotion(): void {
    if (this.#disposed) return;
    if (this.#frame !== undefined) this.#ownerWindow.cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
    this.#clearTimer();
    const lockComplete = this.#onLockComplete;
    if (lockComplete !== undefined) {
      this.restorePreview();
      this.#resetPreviewLayer();
      if (this.#lockEditor !== undefined) {
        this.#lockEditor.hidden = true;
        this.#resetEditorLayer(this.#lockEditor);
      }
      this.#onLockComplete = undefined;
      this.#lockEditor = undefined;
      lockComplete();
      return;
    }
    if (this.#started && !this.#root.classList.contains("inkbook-active-ready")) this.#complete();
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    this.#ownerWindow.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #resetPreviewLayer(): void {
    const previewStyle = this.#preview?.style;
    previewStyle?.removeProperty("inset");
    previewStyle?.removeProperty("position");
    previewStyle?.removeProperty("z-index");
  }

  #resetEditorLayer(editor: HTMLElement | undefined): void {
    editor?.style.removeProperty("z-index");
  }

  #complete(): void {
    if (this.#disposed) return;
    this.#clearTimer();
    this.#root.classList.remove("inkbook-active-preparing", "inkbook-active-transitioning");
    this.#root.classList.add("inkbook-active-ready");
    this.#container.style.removeProperty(ACTIVE_SCENE_BLOCK_SIZE_PROPERTY);
    this.#container.style.removeProperty(LOCKED_CONTAINER_BLOCK_SIZE_PROPERTY);
    if (this.#preview !== undefined) {
      this.#preview.hidden = true;
      (this.#preview as Partial<{ remove(): void }>).remove?.();
    }
    this.#notifyReady();
    this.#releaseTransitionStability();
  }

  #releaseTransitionStability(): void {
    const release = this.#releaseScrollStability;
    this.#releaseScrollStability = undefined;
    release?.();
  }

  #notifyReady(): void {
    const onReady = this.#onReady;
    this.#onReady = undefined;
    onReady?.();
  }

  #reducedMotion(): boolean {
    return (
      this.#motion === "reduced" ||
      (this.#motion === "system" && this.#mediaQuery?.matches === true)
    );
  }
}
