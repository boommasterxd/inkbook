import type { InkbookDeviceSettingsV1 } from "../../domain/settings/types";

type MotionPreference = InkbookDeviceSettingsV1["motion"];

const LOCK_CROSSFADE_DURATION_MS = 120;
const ACTIVE_SCENE_BLOCK_SIZE_PROPERTY = "--inkbook-active-scene-block-size";
const LOCKED_CONTAINER_BLOCK_SIZE_PROPERTY = "--inkbook-locked-container-block-size";

interface PreviewHandoffOptions {
  readonly container: HTMLElement;
  readonly motion: MotionPreference;
  readonly preview: HTMLElement | undefined;
  readonly setPreviewAspectRatio?: (aspectRatio: number) => void;
  readonly setPreviewSource?: (source: string) => Promise<void>;
  readonly root: HTMLElement;
}

export class ActiveScenePreviewHandoff {
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
  #onComplete: (() => void) | undefined;
  #onLockComplete: (() => void) | undefined;
  #lockEditor: HTMLElement | undefined;
  #started = false;
  #timer: number | undefined;
  #frame: number | undefined;

  public constructor(options: PreviewHandoffOptions) {
    const ownerWindow = options.root.ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("The preview handoff requires an owning window.");
    this.#container = options.container;
    this.#motion = options.motion;
    this.#ownerWindow = ownerWindow;
    this.#preview = options.preview;
    this.#setPreviewAspectRatio = options.setPreviewAspectRatio;
    this.#setPreviewSource = options.setPreviewSource;
    this.#previewNextSibling = options.preview?.nextSibling ?? null;
    this.#previewParent = options.preview?.parentNode ?? null;
    this.#root = options.root;
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
    this.#clearTimer();
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
    const previewStyle = this.#preview?.style;
    previewStyle?.removeProperty("inset");
    previewStyle?.removeProperty("opacity");
    previewStyle?.removeProperty("position");
    previewStyle?.removeProperty("transition");
    this.restorePreview();
  }

  public ready(onComplete?: () => void): void {
    if (this.#disposed || this.#started || this.#root.classList.contains("inkbook-active-ready")) {
      return;
    }
    this.#onComplete = onComplete;
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
    this.#frame = this.#ownerWindow.requestAnimationFrame(() => {
      this.#frame = undefined;
      if (this.#disposed) return;
      this.#frame = this.#ownerWindow.requestAnimationFrame(() => {
        this.#frame = undefined;
        if (this.#disposed) return;
        this.#startUnlockTransition(activeBlockSize);
      });
    });
  }

  #startUnlockTransition(activeBlockSize: string): void {
    this.#root.classList.remove("inkbook-active-preparing");
    this.#root.classList.add("inkbook-active-transitioning");
    this.#container.style.blockSize = activeBlockSize;
    this.#timer = this.#ownerWindow.setTimeout(() => this.#complete(), 240);
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

  public crossfadeToPreview(
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
      preview.setCssProps({ opacity: "1", transition: "none" });
      editorChrome.setCssProps({ opacity: "0", transition: "none" });
      onComplete();
      return;
    }
    this.#onLockComplete = onComplete;
    this.#lockEditor = editorChrome;
    preview.classList.add("inkbook-preview-handoff");
    preview.setCssProps({
      inset: "0",
      opacity: "0",
      position: "absolute",
      transition: `opacity ${String(LOCK_CROSSFADE_DURATION_MS)}ms ease`,
    });
    editorChrome.setCssProps({
      opacity: "1",
      transition: `opacity ${String(LOCK_CROSSFADE_DURATION_MS)}ms ease`,
    });
    this.#frame = this.#ownerWindow.requestAnimationFrame(() => {
      this.#frame = undefined;
      if (this.#disposed) return;
      preview.setCssProps({ opacity: "1" });
      editorChrome.setCssProps({ opacity: "0" });
      this.#timer = this.#ownerWindow.setTimeout(() => {
        this.#timer = undefined;
        const complete = this.#onLockComplete;
        this.#onLockComplete = undefined;
        this.#lockEditor = undefined;
        complete?.();
      }, LOCK_CROSSFADE_DURATION_MS);
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
      this.#preview?.setCssProps({ opacity: "1", transition: "none" });
      this.#lockEditor?.setCssProps({ opacity: "0", transition: "none" });
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
    const onComplete = this.#onComplete;
    this.#onComplete = undefined;
    onComplete?.();
  }

  #reducedMotion(): boolean {
    return (
      this.#motion === "reduced" ||
      (this.#motion === "system" && this.#mediaQuery?.matches === true)
    );
  }
}
