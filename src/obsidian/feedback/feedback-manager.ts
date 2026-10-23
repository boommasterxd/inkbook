import { mountFeedbackActionMotion } from "./feedback-action-motion";
import { feedbackContent, type InkbookFeedbackCode } from "./feedback-catalog";
import {
  createFeedbackIconButton,
  createFeedbackSurface,
  setFeedbackPending,
  type InkbookFeedbackAction,
} from "./feedback-surface";
import { mountWindowFeedback } from "./window-feedback-host";
import { observeEffectiveMotion, type ObserveMotion } from "../runtime/effective-motion";
import type { MotionPreference } from "../../rendering/motion/transitions";
import { effectiveTransitionDuration } from "../runtime/effective-motion";
import { animateOwnedElement } from "../runtime/element-motion";

type FeedbackCloseMode = "animated" | "immediate";

export interface InkbookFeedbackHandle {
  close(mode?: FeedbackCloseMode): void;
}

export interface InkbookFeedbackRequest {
  readonly actions?: readonly InkbookFeedbackAction[];
  readonly code: InkbookFeedbackCode;
  readonly onClosed?: () => void;
  readonly timeoutMs?: number;
}

interface ActiveFeedback extends InkbookFeedbackHandle {
  readonly element: HTMLElement;
  readonly handle: InkbookFeedbackHandle;
  readonly refreshActions: () => void;
}

interface FeedbackMotionPreferences {
  readonly readMotion: () => MotionPreference;
  readonly observeMotion: ObserveMotion;
}

export class InkbookFeedbackManager {
  readonly #active = new Set<ActiveFeedback>();
  readonly #presentations = new WeakMap<HTMLElement, ActiveFeedback>();
  readonly #windows = new WeakMap<Document, ActiveFeedback>();
  #disposed = false;

  public constructor(private readonly motionPreferences?: FeedbackMotionPreferences) {}

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
    return active?.handle ?? CLOSED_FEEDBACK;
  }

  public showInWindow(ownerWindow: Window, request: InkbookFeedbackRequest): InkbookFeedbackHandle {
    const ownerDocument = ownerWindow.document;
    this.#windows.get(ownerDocument)?.close("immediate");
    const active = this.#show(ownerDocument.body, "global", request, () => {
      if (this.#windows.get(ownerDocument) === active) this.#windows.delete(ownerDocument);
    });
    if (active !== undefined) this.#windows.set(ownerDocument, active);
    return active?.handle ?? CLOSED_FEEDBACK;
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
    let releasePreference: (() => void) | undefined;
    let presenceMotion: ReturnType<typeof animateOwnedElement> | undefined;
    const { handle, setClose } = createFeedbackHandle();
    const removeActions: Array<() => void> = [];
    const refreshActions: Array<() => void> = [];
    const unmount = mountWindowFeedback(surface.element, container);
    const finish = (): void => {
      if (presence === "closed") return;
      presence = "closed";
      setClose(undefined);
      if (timeout !== undefined) ownerWindow.clearTimeout(timeout);
      presenceMotion?.cancel();
      presenceMotion = undefined;
      releasePreference?.();
      for (const remove of removeActions) remove();
      removeActions.length = 0;
      unmount();
      surface.element.remove();
      this.#active.delete(active);
      onClosed();
      request.onClosed?.();
    };
    const close = (mode: FeedbackCloseMode = "animated"): void => {
      if (presence === "closed" || (presence === "exiting" && mode !== "immediate")) return;
      if (mode === "immediate") {
        finish();
        return;
      }
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
      const canAnimate = durationMs > 0 && typeof surface.element.animate === "function";
      const renderedScale =
        canAnimate && presenceMotion !== undefined
          ? currentFeedbackScale(surface.element, ownerWindow)
          : 1;
      presenceMotion?.cancel();
      if (!canAnimate) {
        finish();
        return;
      }
      presenceMotion = animateOwnedElement(
        surface.element,
        { scale: [renderedScale, 0] },
        {
          duration: durationMs / 1000,
          ease: "easeIn",
          onComplete: finish,
        },
      );
      ignoreCanceledMotion(surface.element, presenceMotion);
    };
    setClose(close);
    if (placement === "global" && this.motionPreferences !== undefined)
      surface.element.dataset.inkbookMotion = this.motionPreferences.readMotion();
    const active = createActiveFeedback(surface.element, handle, refreshActions);
    this.#active.add(active);
    presenceMotion = startFeedbackEntrance(surface.element, ownerWindow);
    releasePreference = observeFeedbackMotion(
      surface.element,
      placement === "global" ? this.motionPreferences : undefined,
      () => {
        if (presence === "exiting") finish();
        else {
          presenceMotion?.cancel();
          presenceMotion = undefined;
          surface.element.setCssProps({ scale: "1" });
        }
      },
      this.motionPreferences?.observeMotion,
    );
    this.#mountActions(surface.actionGroup, request.actions ?? [], active, ownerWindow, {
      removeActions,
      refreshActions,
    });
    if ((request.actions?.length ?? 0) === 0 || request.timeoutMs !== undefined) {
      timeout = ownerWindow.setTimeout(close, request.timeoutMs ?? 5_000);
    }
    return active;
  }

  #mountActions(
    group: HTMLElement,
    actions: readonly InkbookFeedbackAction[],
    active: ActiveFeedback,
    ownerWindow: Window,
    lifecycle: { removeActions: Array<() => void>; refreshActions: Array<() => void> },
  ): void {
    for (const action of actions) {
      const button = createFeedbackIconButton(group, action.id);
      const onClick = (): void => void this.#runAction(active, action);
      button.addEventListener("click", onClick);
      const motion = mountFeedbackActionMotion(button, ownerWindow);
      lifecycle.refreshActions.push(motion.refresh);
      lifecycle.removeActions.push(() => {
        button.removeEventListener("click", onClick);
        motion.dispose();
      });
    }
  }

  async #runAction(feedback: ActiveFeedback, action: InkbookFeedbackAction): Promise<void> {
    if (!feedback.element.isConnected) return;
    setFeedbackPending(feedback.element, true);
    feedback.refreshActions();
    try {
      const result = await action.run();
      if (result !== false) feedback.close();
      else {
        setFeedbackPending(feedback.element, false);
        feedback.refreshActions();
      }
    } catch {
      setFeedbackPending(feedback.element, false);
      feedback.refreshActions();
    }
  }
}

const CLOSED_FEEDBACK: InkbookFeedbackHandle = Object.freeze({ close: (): void => undefined });

function currentFeedbackScale(element: HTMLElement, ownerWindow: Window): number {
  const scale = Number.parseFloat(ownerWindow.getComputedStyle(element).scale);
  return Number.isFinite(scale) ? Math.max(0, Math.min(1, scale)) : 1;
}

function startFeedbackEntrance(
  element: HTMLElement,
  ownerWindow: Window,
): ReturnType<typeof animateOwnedElement> | undefined {
  const durationMs = effectiveTransitionDuration(element, ownerWindow, "conditionalToolbarControl");
  if (durationMs === 0 || typeof element.animate !== "function") return undefined;
  const motion = animateOwnedElement(
    element,
    { scale: [0, 1] },
    { duration: durationMs / 1000, ease: "easeOut" },
  );
  ignoreCanceledMotion(element, motion);
  return motion;
}

function ignoreCanceledMotion(
  element: HTMLElement,
  motion: ReturnType<typeof animateOwnedElement>,
): void {
  for (const native of element.getAnimations?.() ?? []) void native.finished.catch(() => undefined);
  void motion.finished?.catch(() => undefined);
}

function createFeedbackHandle(): {
  readonly handle: InkbookFeedbackHandle;
  readonly setClose: (close: InkbookFeedbackHandle["close"] | undefined) => void;
} {
  let delegate: InkbookFeedbackHandle["close"] | undefined;
  return {
    handle: { close: (mode) => delegate?.(mode) },
    setClose: (close) => {
      delegate = close;
    },
  };
}

function observeFeedbackMotion(
  element: HTMLElement,
  preferences: FeedbackMotionPreferences | undefined,
  onReduced: () => void,
  observeMotion: ObserveMotion | undefined,
): () => void {
  return observeEffectiveMotion(
    element,
    preferences?.readMotion,
    (reduced) => {
      if (preferences !== undefined) element.dataset.inkbookMotion = preferences.readMotion();
      if (reduced) onReduced();
    },
    observeMotion,
  );
}

function createActiveFeedback(
  element: HTMLElement,
  handle: InkbookFeedbackHandle,
  refreshActions: ReadonlyArray<() => void>,
): ActiveFeedback {
  return {
    close: (mode) => handle.close(mode),
    element,
    handle,
    refreshActions: () => refreshActions.forEach((refresh) => refresh()),
  };
}
