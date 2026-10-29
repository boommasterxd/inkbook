import type { Keymap } from "obsidian";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { FocusTargetPort } from "../../menus/menu-ports";
import { OnboardingCoach, type CoachStep } from "./onboarding-coach";
import { OnboardingPageSpace } from "./onboarding-page-space";
import { ONBOARDING_STEPS } from "./onboarding-steps";
import { revealOnboardingTarget } from "./onboarding-target";
import type { OnboardingBackgroundPort } from "./onboarding-background";
import type { BrowserScrollElement } from "../../scrolling/index";

interface OnboardingTourOptions {
  readonly root: HTMLElement;
  readonly canvasInputSurface: FocusTargetPort;
  readonly workScheduler: WorkScheduler;
  readonly keymap?: Pick<Keymap, "popScope" | "pushScope">;
  readonly renderIcon?: (element: HTMLElement, icon: string) => void;
  readonly onStateChanged?: () => void;
  readonly background?: OnboardingBackgroundPort;
  readonly scrollOwner?: () => BrowserScrollElement;
}

/** Handwritten application chrome; no store, camera, history, or export mutations. */
export class OnboardingTour {
  readonly #options: OnboardingTourOptions;
  readonly #space: OnboardingPageSpace;
  #session: OnboardingCoach | undefined;
  #exiting: OnboardingCoach | undefined;
  #returnFocus: HTMLElement | undefined;
  #index = 0;
  #disposed = false;
  #invitation = false;
  #steps: readonly CoachStep[] = [];
  #contextPreview = false;

  public constructor(options: OnboardingTourOptions) {
    this.#options = options;
    this.#space = new OnboardingPageSpace(options.root, options.workScheduler, options.background);
  }

  public showInvitation(visible: boolean): void {
    this.#invitation = visible;
    if (this.#session === undefined && this.#exiting === undefined)
      this.#space.setMinimum(visible ? 220 : 0);
  }

  public get contextPreview(): boolean {
    return this.#contextPreview;
  }

  public open(returnFocus?: HTMLElement): void {
    if (this.#disposed || !this.#options.root.isConnected) return;
    this.#session?.dispose();
    this.#exiting?.dispose();
    this.#exiting = undefined;
    this.#returnFocus = returnFocus;
    this.#index = 0;
    this.#steps = ONBOARDING_STEPS.filter(
      (step) =>
        !step.optional ||
        this.#options.root.querySelector(`[data-inkbook-action="${step.action}"]`) !== null,
    );
    let minimum = 360;
    this.#session = new OnboardingCoach({
      ...this.#options,
      onClose: (restoreFocus = true) => this.close(restoreFocus),
      onSpaceRequired: (height) => {
        if (height === minimum) return;
        minimum = height;
        this.#space.setMinimum(height, false, () => this.#session?.revealIfNeeded());
      },
      onNavigate: (direction) => {
        this.#index = Math.max(0, Math.min(this.#steps.length - 1, this.#index + direction));
        this.#show();
      },
    });
    const session = this.#session;
    this.#space.setMinimum(360, false, () => {
      if (this.#session === session) session.revealIfNeeded();
    });
    this.#show();
    session.revealIfNeeded();
  }

  public close(restoreFocus = true): void {
    const session = this.#session;
    this.#session = undefined;
    this.#setPreview(false);
    if (session !== undefined) {
      this.#exiting = session;
      session.close(() => {
        if (this.#exiting !== session) return;
        this.#exiting = undefined;
        this.#space.setMinimum(this.#invitation ? 220 : 0);
      });
    }
    if (session !== undefined && restoreFocus) this.#restoreFocus();
    else this.#returnFocus = undefined;
  }

  public dispose(): void {
    this.#disposed = true;
    this.#session?.dispose();
    this.#session = undefined;
    this.#exiting?.dispose();
    this.#exiting = undefined;
    this.#setPreview(false);
    this.#space.dispose();
  }

  #show(): void {
    const step = this.#steps[this.#index];
    if (step === undefined) return;
    this.#setPreview(step.previewContext === true);
    this.#session?.show(step, this.#index, this.#steps.length);
  }

  #setPreview(preview: boolean): void {
    if (preview === this.#contextPreview) return;
    this.#contextPreview = preview;
    this.#options.onStateChanged?.();
  }

  #restoreFocus(): void {
    const target = this.#returnFocus;
    this.#returnFocus = undefined;
    const document = this.#options.root.ownerDocument;
    const active = document.activeElement;
    if (
      active?.isConnected &&
      active !== document.body &&
      active !== document.documentElement &&
      active !== target &&
      active.closest('.inkbook-onboarding-layer[aria-hidden="true"]') === null
    )
      return;
    if (target?.isConnected) revealOnboardingTarget(target);
    (target?.isConnected ? target : this.#options.canvasInputSurface).focus({
      preventScroll: true,
    });
  }
}
