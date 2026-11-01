import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { TRANSITION_DURATIONS } from "../../../rendering/motion/transitions";
import { ActiveHeightTransition } from "../active-editor/layout/height-transition";

const SPACING_PROPERTY = "--inkbook-toolbar-spacing";

/** Reserves note-flow space for the floating toolbar without resizing document ink. */
export class ToolbarSpacing {
  readonly #root: HTMLElement;
  readonly #transition: ActiveHeightTransition;
  readonly #expanded: number;
  #height = 0;
  #target = 0;

  public constructor(root: HTMLElement, editorChrome: HTMLElement, scheduler: WorkScheduler) {
    this.#root = root;
    this.#transition = new ActiveHeightTransition(editorChrome, scheduler);
    const value = root.ownerDocument.defaultView
      ?.getComputedStyle(root)
      .getPropertyValue("--inkbook-toolbar-overlay-block-size");
    const height = Number.parseFloat(value ?? "");
    this.#expanded = Number.isFinite(height) ? Math.max(0, height) : 0;
  }

  public get expanded(): number {
    return this.#expanded;
  }

  public setOpen(open: boolean, reduced: boolean): void {
    const target = open ? this.#expanded : 0;
    if (target === this.#target) {
      if (reduced) this.finish();
      return;
    }
    this.#target = target;
    this.#transition.cancel();
    if (reduced) {
      this.#apply(target);
      return;
    }
    this.#transition.begin({
      currentRenderedHeight: this.#height,
      targetRenderedHeight: target,
      durationMs: TRANSITION_DURATIONS.lockedToActiveHeight,
      ...(open ? { easing: "ease-out" as const } : {}),
      paintPrepared: true,
      sceneCommitPending: () => false,
      applySurfaceTarget: () => undefined,
      applyFrame: (height) => this.#apply(height),
      onComplete: () => undefined,
      stabilizeScroll: false,
    });
  }

  public finish(): void {
    this.#transition.finishImmediately();
  }

  public dispose(): void {
    this.#transition.cancel();
    this.#root.style.removeProperty(SPACING_PROPERTY);
  }

  #apply(height: number): void {
    this.#height = height;
    this.#root.style.setProperty(SPACING_PROPERTY, `${String(height)}px`);
  }
}
