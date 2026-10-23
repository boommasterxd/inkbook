import { setIcon } from "obsidian";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { bindFeedbackPresentationStyle } from "../../feedback/window-feedback-host";
import { effectiveTransitionDuration } from "../../runtime/effective-motion";
import { animateOwnedElement } from "../../runtime/element-motion";

import {
  createPresentationFeedbackPositionLifecycle,
  type PresentationFeedbackPositionLifecycle,
} from "../../feedback";

export const PRESENTATION_LOADING_FEEDBACK_DELAY_MS = 500;
export const PRESENTATION_SAVING_FEEDBACK_DELAY_MS = 150;

export type PresentationOperationKind = "loading" | "saving";

export interface PresentationOperationFeedbackHandle {
  finish(): void;
}

const FINISHED_FEEDBACK = Object.freeze({ finish: (): void => undefined });

export class PresentationOperationFeedback {
  #activeToken = 0;
  #disposed = false;
  #frame: number | undefined;
  #indicator: HTMLElement | undefined;
  #host: HTMLElement | undefined;
  #unbindStyle: (() => void) | undefined;
  #positioning: PresentationFeedbackPositionLifecycle | undefined;
  #spin: ReturnType<typeof animateOwnedElement> | undefined;
  readonly #motionQuery: MediaQueryList | undefined;
  readonly #motionChanged = (): void => this.#syncSpin();
  readonly #ownerWindow: Window;
  readonly #workScheduler: WorkScheduler;
  readonly #root: HTMLElement;
  readonly #onLoadingShown: (() => void) | undefined;
  #timer: number | undefined;

  public constructor(
    root: HTMLElement,
    onLoadingShown?: () => void,
    workScheduler?: WorkScheduler,
  ) {
    const ownerWindow = root.ownerDocument.defaultView;
    if (ownerWindow === null) {
      throw new Error("Presentation feedback requires an owning window.");
    }
    this.#ownerWindow = ownerWindow;
    if (workScheduler === undefined)
      throw new Error("Presentation feedback requires a work scheduler.");
    this.#workScheduler = workScheduler;
    this.#root = root;
    this.#onLoadingShown = onLoadingShown;
    this.#motionQuery = ownerWindow.matchMedia?.("(prefers-reduced-motion: reduce)");
    this.#motionQuery?.addEventListener("change", this.#motionChanged);
  }

  public begin(
    kind: PresentationOperationKind,
    startedAt?: number,
  ): PresentationOperationFeedbackHandle {
    if (this.#disposed) return FINISHED_FEEDBACK;
    this.#clearCurrent();
    const token = ++this.#activeToken;
    const delay = this.#remainingDelay(kind, startedAt);
    if (delay === 0) {
      this.#show(kind);
      return { finish: () => this.#finish(token) };
    }
    this.#timer = this.#ownerWindow.setTimeout(() => {
      this.#timer = undefined;
      if (this.#disposed || token !== this.#activeToken) return;
      if (kind === "saving") {
        this.#show(kind);
        return;
      }
      this.#frame = this.#workScheduler.requestFrame(() => {
        if (this.#disposed || token !== this.#activeToken) return;
        this.#frame = undefined;
        this.#show(kind);
      });
    }, delay);
    return { finish: () => this.#finish(token) };
  }

  public finish(): void {
    if (this.#disposed) return;
    this.#activeToken += 1;
    this.#clearCurrent();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#activeToken += 1;
    this.#clearCurrent();
    this.#motionQuery?.removeEventListener("change", this.#motionChanged);
  }

  #remainingDelay(kind: PresentationOperationKind, startedAt?: number): number {
    const delay = feedbackDelay(kind);
    if (kind !== "loading" || startedAt === undefined || !Number.isFinite(startedAt)) {
      return delay;
    }
    const now = this.#ownerWindow.performance?.now() ?? performance.now();
    return Math.max(0, delay - Math.max(0, now - startedAt));
  }

  #finish(token: number): void {
    if (this.#disposed || token !== this.#activeToken) return;
    this.finish();
  }

  #show(kind: PresentationOperationKind): void {
    if (kind === "loading") this.#onLoadingShown?.();
    const label = kind === "loading" ? "Loading drawing" : "Saving drawing";
    const indicator = (this.#ownerWindow as Window & { createDiv: typeof createDiv }).createDiv({
      cls: "inkbook-operation-feedback",
    });
    indicator.setAttribute("role", "status");
    indicator.setAttribute("aria-atomic", "true");
    indicator.setAttribute("aria-label", label);
    indicator.dataset.inkbookOperation = kind;
    const icon = indicator.createSpan({ cls: "inkbook-operation-feedback-icon" });
    icon.setAttribute("aria-hidden", "true");
    setIcon(icon, "loader-circle");
    this.#indicator = indicator;
    const host = (this.#ownerWindow as Window & { createDiv: typeof createDiv }).createDiv({
      cls: "inkbook-root inkbook-operation-feedback-host",
    });
    host.appendChild(indicator);
    this.#host = host;
    this.#unbindStyle = bindFeedbackPresentationStyle(host, this.#root, this.#motionChanged);
    this.#positioning = createPresentationFeedbackPositionLifecycle(
      indicator,
      this.#root,
      "center",
      this.#workScheduler,
      host,
    );
    this.#syncSpin();
  }

  #syncSpin(): void {
    const icon = this.#indicator?.firstElementChild as HTMLElement | null | undefined;
    if (icon == null) return;
    const allowed = effectiveTransitionDuration(icon, this.#ownerWindow, "styleChange") > 0;
    if (!allowed && this.#spin !== undefined) {
      this.#spin.cancel();
      this.#spin = undefined;
      icon.style.removeProperty("rotate");
    }
    if (!allowed || this.#spin !== undefined || typeof icon.animate !== "function") return;
    this.#spin = animateOwnedElement(
      icon,
      { rotate: ["0deg", "360deg"] },
      {
        duration: 0.8,
        ease: "linear",
        repeat: Infinity,
      },
    );
    for (const native of icon.getAnimations()) void native.finished.catch(() => undefined);
    void this.#spin.finished.catch(() => undefined);
  }

  #clearCurrent(): void {
    this.#spin?.cancel();
    this.#spin = undefined;
    if (this.#timer !== undefined) this.#ownerWindow.clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#frame !== undefined) this.#workScheduler.cancelFrame(this.#frame);
    this.#frame = undefined;
    this.#positioning?.dispose();
    this.#positioning = undefined;
    this.#unbindStyle?.();
    this.#unbindStyle = undefined;
    this.#host?.remove();
    this.#host = undefined;
    this.#indicator?.remove();
    this.#indicator = undefined;
  }
}

function feedbackDelay(kind: PresentationOperationKind): number {
  return kind === "loading"
    ? PRESENTATION_LOADING_FEEDBACK_DELAY_MS
    : PRESENTATION_SAVING_FEEDBACK_DELAY_MS;
}
