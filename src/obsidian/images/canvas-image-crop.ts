import type { Localization } from "../../domain/localization";
import { applyImageCrop } from "../../domain/images/image-crop";
import type { Keymap } from "obsidian";
import type { ImageCropV3, ImageElementV3, ImageResourceV3 } from "../../domain/schema/public";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { STANDARD_EASING, type MotionPreference } from "../../rendering/motion/transitions";
import type { SvgSceneRenderer } from "../../rendering/scene/scene-renderer";
import { bindElementLanguage } from "../../rendering/localization/element-language";
import { registerNativeControlFeedback } from "../menus/feedback/native-control-feedback";
import { animateOwnedElement } from "../runtime/element-motion";
import { effectiveTransitionDuration, observeEffectiveMotion } from "../runtime/effective-motion";
import { ImageCropDraft } from "./image-crop-draft";
import { ImageCropHandles } from "./image-crop-handles";
import { ImageCropLayout } from "./image-crop-layout";
import { installMenuEscapeScope } from "../menus/menu-escape-scope";

export interface CanvasImageCropOptions {
  readonly container: HTMLElement;
  readonly chromeHost?: HTMLElement;
  readonly keymap?: Pick<Keymap, "pushScope" | "popScope"> | undefined;
  readonly image: ImageElementV3;
  readonly resource: ImageResourceV3;
  readonly renderer: Pick<
    SvgSceneRenderer,
    "beginImageCrop" | "inputSurface" | "flushPointerFeedbackFrame" | "setElementPreviews"
  >;
  readonly localization: Localization;
  readonly signal: AbortSignal;
  readonly scheduler: WorkScheduler;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly readMotion: () => MotionPreference;
  readonly onActiveChanged: (active: boolean) => void;
  readonly subscribeChanges: (cancel: () => void) => () => void;
}

/** Draft chrome is a sibling of the temporarily inert canvas, never a modal or document edit. */
export function openCanvasImageCrop(
  options: CanvasImageCropOptions,
): Promise<ImageCropV3 | undefined> {
  if (options.signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    let failed = false;
    const crop = new CanvasImageCrop(options, (result) => {
      if (!failed) resolve(result);
    });
    try {
      crop.open();
    } catch (error) {
      failed = true;
      crop.close();
      reject(error instanceof Error ? error : new Error("Image cropping could not be opened."));
    }
  });
}

class CanvasImageCrop {
  readonly #draft: ImageCropDraft;
  readonly #root: HTMLDivElement;
  readonly #outline: HTMLDivElement;
  readonly #actions: HTMLDivElement;
  readonly #layout: ImageCropLayout;
  readonly #release: Array<() => void> = [];
  #handles: ImageCropHandles | undefined;
  #presentation: ReturnType<SvgSceneRenderer["beginImageCrop"]> | undefined;
  #animation: ReturnType<typeof animateOwnedElement> | undefined;
  #frame: number | undefined;
  #closed = false;
  readonly #cancel = (): void => this.close();

  public constructor(
    private readonly options: CanvasImageCropOptions,
    private readonly resolve: (result: ImageCropV3 | undefined) => void,
  ) {
    this.#draft = new ImageCropDraft(options.resource, options.image.crop);
    const host = options.chromeHost ?? options.container;
    this.#root = host.createDiv({ cls: "inkbook-image-crop" });
    this.#layout = new ImageCropLayout(options.container, options.image, this.#root);
    this.#root.setAttribute("role", "group");
    this.#root.setAttribute("aria-label", options.localization.t("images.crop"));
    const hint = this.#root.createDiv({ cls: "inkbook-menu-visually-hidden" });
    hint.id = `inkbook-crop-${options.image.id}`;
    hint.textContent = `${options.localization.t("images.cropHint")} ${options.localization.t("images.cropNotice")}`;
    this.#root.setAttribute("aria-describedby", hint.id);
    this.#actions = this.#root.createDiv({ cls: "inkbook-image-crop-actions" });
    this.#actions.setAttribute("role", "toolbar");
    this.#actions.setAttribute("aria-label", options.localization.t("images.crop"));
    this.#action("images.cancel", "x", () => this.close());
    this.#action("images.apply", "check", () => this.close({ ...this.#draft.crop }));
    this.#outline = this.#root.createDiv({ cls: "inkbook-image-crop-outline" });
  }

  public open(): void {
    const options = this.options;
    options.onActiveChanged(true);
    this.#release.push(() => options.onActiveChanged(false));
    this.#release.push(bindElementLanguage(this.#root, options.localization));
    this.#release.push(installMenuEscapeScope(options.keymap, this.#cancel));
    this.#presentation = options.renderer.beginImageCrop(
      options.image,
      options.resource,
      (camera) => {
        this.#layout.setCamera(camera);
        this.#paint();
      },
    );
    this.#handles = new ImageCropHandles({
      outline: this.#outline,
      draft: this.#draft,
      t: options.localization.t,
      sourcePoint: this.#layout.sourcePoint,
      update: () => this.#schedule(false),
    });
    for (const type of ["pointerdown", "mousedown", "click", "dblclick"] as const)
      this.#listen(this.#root, type, (event) => event.stopPropagation());
    this.#listen(this.#root.ownerDocument, "keydown", (event) => this.#key(event));
    this.#listen(this.#root.ownerDocument, "scroll", () => this.#schedule(true), true);
    const ownerWindow = this.#root.ownerDocument.defaultView!;
    this.#listen(ownerWindow, "resize", () => this.#schedule(true));
    const resize = new ownerWindow.ResizeObserver(() => this.#schedule(true));
    resize.observe(options.container);
    this.#release.push(() => resize.disconnect());
    this.#release.push(options.subscribeChanges(this.#cancel));
    options.signal.addEventListener("abort", this.#cancel, { once: true });
    this.#release.push(() => options.signal.removeEventListener("abort", this.#cancel));
    this.#release.push(registerNativeControlFeedback(this.#actions, options));
    this.#release.push(
      observeEffectiveMotion(this.#root, options.readMotion, (reduced) => {
        if (reduced) {
          this.#animation?.complete();
        }
      }),
    );
    this.#paint();
    this.#root
      .querySelector<HTMLButtonElement>('[data-edges="left top"]')!
      .focus({ preventScroll: true });
    const duration = effectiveTransitionDuration(this.#root, ownerWindow, "fallback");
    if (duration > 0)
      this.#animation = animateOwnedElement(
        this.#root,
        { opacity: [0, 1] },
        {
          duration: duration / 1000,
          ease: [...STANDARD_EASING],
        },
      );
    if (options.signal.aborted) this.close();
  }

  #action(key: "images.cancel" | "images.apply", icon: string, activate: () => void): void {
    const label = this.options.localization.t(key);
    const button = this.#actions.createEl("button", {
      cls: "clickable-icon inkbook-image-crop-action",
    });
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    this.options.renderIcon(button, icon);
    button.querySelector("svg")?.setAttribute("aria-hidden", "true");
    this.#listen(button, "click", (event) => {
      event.stopPropagation();
      activate();
    });
  }

  #listen<K extends keyof DocumentEventMap>(
    target: Document | HTMLElement | Window,
    type: K,
    listener: (event: DocumentEventMap[K]) => void,
    capture = false,
  ): void {
    target.addEventListener(type, listener as EventListener, capture);
    this.#release.push(() => target.removeEventListener(type, listener as EventListener, capture));
  }

  #key(event: KeyboardEvent): void {
    if (!this.#root.contains(event.target as Node)) return;
    if (event.key === "Tab") {
      const buttons = [...this.#root.querySelectorAll<HTMLButtonElement>("button")];
      const index = buttons.indexOf(this.#root.ownerDocument.activeElement as HTMLButtonElement);
      buttons[(index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length]!.focus({
        preventScroll: true,
      });
    } else if (event.key === "Escape") this.close();
    else if (event.key === "Enter") {
      if (event.target === this.#actions.firstElementChild) this.close();
      else this.close({ ...this.#draft.crop });
    } else if (event.key === "Home") {
      this.#draft.reset();
      this.#schedule(false);
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }

  #needsMeasure = false;
  #schedule(measure: boolean): void {
    if (this.#closed) return;
    this.#needsMeasure ||= measure;
    if (this.#frame !== undefined) return;
    let synchronous = false;
    const frame = this.options.scheduler.requestFrame(() => {
      synchronous = true;
      this.#frame = undefined;
      if (this.#closed) return;
      if (this.#needsMeasure) this.#layout.measure();
      this.#needsMeasure = false;
      this.#paint();
    }, "input");
    if (!synchronous) this.#frame = frame;
  }

  #paint(): void {
    if (this.#closed) return;
    this.#presentation?.update(this.#draft.crop);
    this.options.renderer.flushPointerFeedbackFrame();
    this.#layout.update(this.#draft.crop, this.#outline, this.#actions);
  }

  public close(result?: ImageCropV3): void {
    if (this.#closed) return;
    this.#closed = true;
    const restoreFocus = this.#root.contains(this.#root.ownerDocument.activeElement);
    if (this.#frame !== undefined) this.options.scheduler.cancelFrame(this.#frame);
    this.#animation?.stop();
    this.#handles?.dispose();
    if (result !== undefined) {
      this.options.renderer.setElementPreviews([applyImageCrop(this.options.image, result)], 1);
      this.options.renderer.flushPointerFeedbackFrame();
    }
    this.#presentation?.dispose();
    this.#root.remove();
    for (const release of this.#release.reverse()) release();
    if (
      restoreFocus &&
      this.options.renderer.inputSurface.isConnected &&
      !this.options.renderer.inputSurface.inert
    )
      this.options.renderer.inputSurface.focus({ preventScroll: true });
    this.resolve(result);
  }
}
