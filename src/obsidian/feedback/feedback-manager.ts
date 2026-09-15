import { feedbackContent, type InkbookFeedbackCode } from "./feedback-catalog";
import {
  createFeedbackIconButton,
  createFeedbackSurface,
  setFeedbackPending,
  type InkbookFeedbackAction,
} from "./feedback-surface";
import { mountWindowFeedback } from "./window-feedback-host";
import { effectiveTransitionDuration } from "../runtime/effective-motion";

type FeedbackCloseMode = "animated" | "immediate";

export interface InkbookFeedbackHandle {
  close(mode?: FeedbackCloseMode): void;
}

export interface InkbookFeedbackRequest {
  readonly actions?: readonly InkbookFeedbackAction[];
  readonly code: InkbookFeedbackCode;
  readonly timeoutMs?: number;
}

interface ActiveFeedback extends InkbookFeedbackHandle {
  readonly element: HTMLElement;
}

export class InkbookFeedbackManager {
  readonly #active = new Set<ActiveFeedback>();
  readonly #presentations = new WeakMap<HTMLElement, ActiveFeedback>();
  readonly #windows = new WeakMap<Document, ActiveFeedback>();
  #disposed = false;

  public closePresentation(root: HTMLElement): void {
    this.#presentations.get(root)?.close();
  }

  public showInPresentation(
    root: HTMLElement,
    request: InkbookFeedbackRequest,
  ): InkbookFeedbackHandle {
    const previous = this.#presentations.get(root);
    previous?.close("immediate");
    const active = this.#show(root, "presentation", request, () => {
      if (this.#presentations.get(root) === active) this.#presentations.delete(root);
    });
    if (active !== undefined) this.#presentations.set(root, active);
    return active ?? CLOSED_FEEDBACK;
  }

  public showInWindow(ownerWindow: Window, request: InkbookFeedbackRequest): InkbookFeedbackHandle {
    const ownerDocument = ownerWindow.document;
    this.#windows.get(ownerDocument)?.close("immediate");
    const active = this.#show(ownerDocument.body, "global", request, () => {
      if (this.#windows.get(ownerDocument) === active) this.#windows.delete(ownerDocument);
    });
    if (active !== undefined) this.#windows.set(ownerDocument, active);
    return active ?? CLOSED_FEEDBACK;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const feedback of [...this.#active]) feedback.close("immediate");
  }

  #show(
    container: HTMLElement,
    placement: "global" | "presentation",
    request: InkbookFeedbackRequest,
    onClosed: () => void,
  ): ActiveFeedback | undefined {
    if (this.#disposed) return undefined;
    const ownerWindow = container.ownerDocument.defaultView;
    if (ownerWindow === null) return undefined;
    const surface = createFeedbackSurface(container, feedbackContent(request.code));
    surface.element.classList.add(`inkbook-feedback-${placement}`);
    let presence: "open" | "exiting" | "closed" = "open";
    let timeout: number | undefined;
    let exitTimeout: number | undefined;
    const unmount = mountWindowFeedback(surface.element, container);
    const finish = (): void => {
      if (presence === "closed") return;
      presence = "closed";
      if (timeout !== undefined) ownerWindow.clearTimeout(timeout);
      if (exitTimeout !== undefined) ownerWindow.clearTimeout(exitTimeout);
      unmount();
      surface.element.remove();
      this.#active.delete(active);
      onClosed();
    };
    const close = (mode: FeedbackCloseMode = "animated"): void => {
      if (presence === "closed") return;
      if (mode === "immediate") {
        finish();
        return;
      }
      if (presence === "exiting") return;
      presence = "exiting";
      if (timeout !== undefined) ownerWindow.clearTimeout(timeout);
      surface.element.dataset.inkbookFeedbackPresence = "exiting";
      surface.element.setAttribute("aria-hidden", "true");
      surface.element.inert = true;
      const durationMs = effectiveTransitionDuration(
        surface.element,
        ownerWindow,
        "conditionalToolbarControl",
      );
      if (durationMs === 0) finish();
      else exitTimeout = ownerWindow.setTimeout(finish, durationMs);
    };
    const active: ActiveFeedback = { close, element: surface.element };
    this.#active.add(active);
    for (const action of request.actions ?? []) {
      const button = createFeedbackIconButton(surface.actionGroup, action.id);
      button.addEventListener("click", () => void this.#runAction(active, action));
    }
    if ((request.actions?.length ?? 0) === 0 || request.timeoutMs !== undefined) {
      timeout = ownerWindow.setTimeout(close, request.timeoutMs ?? 5_000);
    }
    return active;
  }

  async #runAction(feedback: ActiveFeedback, action: InkbookFeedbackAction): Promise<void> {
    if (!feedback.element.isConnected) return;
    setFeedbackPending(feedback.element, true);
    try {
      const result = await action.run();
      if (result !== false) feedback.close();
      else setFeedbackPending(feedback.element, false);
    } catch {
      setFeedbackPending(feedback.element, false);
    }
  }
}

const CLOSED_FEEDBACK: InkbookFeedbackHandle = Object.freeze({ close: (): void => undefined });
