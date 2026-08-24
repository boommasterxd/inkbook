import { setIcon } from "obsidian";

export const PRESENTATION_LOADING_FEEDBACK_DELAY_MS = 1_200;
export const PRESENTATION_SAVING_FEEDBACK_DELAY_MS = 150;

export type PresentationOperationKind = "loading" | "saving";

export interface PresentationOperationFeedbackHandle {
  finish(): void;
}

const FINISHED_FEEDBACK = Object.freeze({ finish: (): void => undefined });

export class PresentationOperationFeedback {
  #activeToken = 0;
  #disposed = false;
  #indicator: HTMLElement | undefined;
  readonly #ownerWindow: Window;
  readonly #root: HTMLElement;
  #timer: number | undefined;

  public constructor(root: HTMLElement) {
    const ownerWindow = root.ownerDocument.defaultView;
    if (ownerWindow === null) {
      throw new Error("Presentation feedback requires an owning window.");
    }
    this.#ownerWindow = ownerWindow;
    this.#root = root;
  }

  public begin(kind: PresentationOperationKind): PresentationOperationFeedbackHandle {
    if (this.#disposed) return FINISHED_FEEDBACK;
    this.#clearCurrent();
    const token = ++this.#activeToken;
    this.#timer = this.#ownerWindow.setTimeout(() => {
      this.#timer = undefined;
      if (!this.#disposed && token === this.#activeToken) this.#show(kind);
    }, feedbackDelay(kind));
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

  #finish(token: number): void {
    if (this.#disposed || token !== this.#activeToken) return;
    this.finish();
  }

  #show(kind: PresentationOperationKind): void {
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
  }

  #clearCurrent(): void {
    if (this.#timer !== undefined) this.#ownerWindow.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#indicator?.remove();
    this.#indicator = undefined;
  }
}

function feedbackDelay(kind: PresentationOperationKind): number {
  return kind === "loading"
    ? PRESENTATION_LOADING_FEEDBACK_DELAY_MS
    : PRESENTATION_SAVING_FEEDBACK_DELAY_MS;
}
