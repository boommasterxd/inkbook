import { setIcon } from "obsidian";

import {
  createPresentationFeedbackPositionLifecycle,
  type PresentationFeedbackPositionLifecycle,
} from "../feedback";

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
  #positioning: PresentationFeedbackPositionLifecycle | undefined;
  readonly #ownerWindow: Window;
  readonly #root: HTMLElement;
  readonly #onLoadingShown: (() => void) | undefined;
  #timer: number | undefined;

  public constructor(root: HTMLElement, onLoadingShown?: () => void) {
    const ownerWindow = root.ownerDocument.defaultView;
    if (ownerWindow === null) {
      throw new Error("Presentation feedback requires an owning window.");
    }
    this.#ownerWindow = ownerWindow;
    this.#root = root;
    this.#onLoadingShown = onLoadingShown;
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
      this.#frame = this.#ownerWindow.requestAnimationFrame(() => {
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
    const indicator = this.#root.createDiv({ cls: "inkbook-operation-feedback" });
    indicator.setAttribute("role", "status");
    indicator.setAttribute("aria-atomic", "true");
    indicator.setAttribute("aria-label", label);
    indicator.dataset.inkbookOperation = kind;
    const icon = indicator.createSpan({ cls: "inkbook-operation-feedback-icon" });
    icon.setAttribute("aria-hidden", "true");
    setIcon(icon, "loader-circle");
    this.#indicator = indicator;
    this.#positioning = createPresentationFeedbackPositionLifecycle(
      indicator,
      this.#root,
      "center",
    );
  }

  #clearCurrent(): void {
    if (this.#timer !== undefined) this.#ownerWindow.clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#frame !== undefined) this.#ownerWindow.cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
    this.#positioning?.dispose();
    this.#positioning = undefined;
    this.#indicator?.remove();
    this.#indicator = undefined;
  }
}

function feedbackDelay(kind: PresentationOperationKind): number {
  return kind === "loading"
    ? PRESENTATION_LOADING_FEEDBACK_DELAY_MS
    : PRESENTATION_SAVING_FEEDBACK_DELAY_MS;
}
