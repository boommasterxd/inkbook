import { feedbackContent, type InkbookFeedbackCode } from "./feedback-catalog";
import {
  createFeedbackIconButton,
  createFeedbackSurface,
  setFeedbackPending,
  type InkbookFeedbackAction,
} from "./feedback-surface";
import {
  createPresentationFeedbackPositionLifecycle,
  type PresentationFeedbackPositionLifecycle,
} from "./presentation-feedback-position";

export interface InkbookFeedbackHandle {
  close(): void;
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
    previous?.close();
    const active = this.#show(
      root,
      "presentation",
      request,
      () => {
        if (this.#presentations.get(root) === active) this.#presentations.delete(root);
      },
      (surface) => createPresentationFeedbackPositionLifecycle(surface, root),
    );
    if (active !== undefined) this.#presentations.set(root, active);
    return active ?? CLOSED_FEEDBACK;
  }

  public showInViewOrWindow(
    ownerWindow: Window,
    view: HTMLElement | undefined,
    request: InkbookFeedbackRequest,
  ): InkbookFeedbackHandle {
    const ownerDocument = ownerWindow.document;
    this.#windows.get(ownerDocument)?.close();
    const host = ownerDocument.body.createDiv({
      cls: `inkbook-root inkbook-feedback-host inkbook-feedback-host-${view === undefined ? "window" : "view"}`,
    });
    (view ?? ownerDocument.body).append(host);
    const active = this.#show(host, "global", request, () => {
      if (this.#windows.get(ownerDocument) === active) this.#windows.delete(ownerDocument);
      host.remove();
    });
    if (active !== undefined) this.#windows.set(ownerDocument, active);
    else host.remove();
    return active ?? CLOSED_FEEDBACK;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const feedback of [...this.#active]) feedback.close();
  }

  #show(
    container: HTMLElement,
    placement: "global" | "presentation",
    request: InkbookFeedbackRequest,
    onClosed: () => void,
    createLifecycle?: (surface: HTMLElement) => PresentationFeedbackPositionLifecycle,
  ): ActiveFeedback | undefined {
    if (this.#disposed) return undefined;
    const ownerWindow = container.ownerDocument.defaultView;
    if (ownerWindow === null) return undefined;
    const surface = createFeedbackSurface(container, feedbackContent(request.code));
    surface.element.classList.add(`inkbook-feedback-${placement}`);
    let closed = false;
    let timeout: number | undefined;
    let lifecycle: PresentationFeedbackPositionLifecycle | undefined;
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (timeout !== undefined) ownerWindow.clearTimeout(timeout);
      lifecycle?.dispose();
      surface.element.remove();
      this.#active.delete(active);
      onClosed();
    };
    const active: ActiveFeedback = { close, element: surface.element };
    this.#active.add(active);
    for (const action of request.actions ?? []) {
      const button = createFeedbackIconButton(surface.actionGroup, action.id);
      button.addEventListener("click", () => void this.#runAction(active, action));
    }
    lifecycle = createLifecycle?.(surface.element);
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
