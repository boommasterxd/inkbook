import type { InkbookEditorChromeProps } from "../../../rendering/ui/editor-chrome-types";
import type { ActiveEditorControllerOptions } from "./controller-types";
import { OnboardingTour } from "./onboarding-tour";
import type { ToolbarState } from "../../../rendering/ui/toolbar-types";
import type { BrowserScrollElement } from "../../scrolling/index";

type OnboardingOptions = Pick<
  ActiveEditorControllerOptions,
  | "container"
  | "deviceSettings"
  | "keymap"
  | "onDismissOnboarding"
  | "onFeedback"
  | "onStateChanged"
  | "renderer"
  | "renderIcon"
  | "workScheduler"
>;

/** Keeps the one-time invitation independent of document data and pointer updates. */
export class ActiveEditorOnboarding {
  readonly #options: OnboardingOptions;
  readonly #root: HTMLElement;
  readonly #tour: OnboardingTour;
  #dismissed: boolean;
  #enabled = false;
  #offered = false;
  #visible = false;
  readonly #invitation: NonNullable<InkbookEditorChromeProps["onboarding"]>;

  public constructor(options: OnboardingOptions, scrollOwner: () => BrowserScrollElement) {
    this.#options = options;
    this.#invitation = {
      container: options.container,
      onStart: () => this.open(),
      onDismiss: () => this.#dismiss(),
    };
    this.#dismissed = options.deviceSettings.onboardingDismissed;
    this.#root = options.container.closest<HTMLElement>(".inkbook-root") ?? options.container;
    this.#tour = new OnboardingTour({
      root: this.#root,
      canvasInputSurface: options.renderer.inputSurface,
      workScheduler: options.workScheduler,
      scrollOwner,
      renderIcon: options.renderIcon,
      background: {
        setMinimumBlockSize: (minimum) => options.renderer.setMinimumBackgroundBlockSize(minimum),
        readCommitProof: () => options.renderer.sceneCommitProof,
      },
      onStateChanged: options.onStateChanged,
      ...(options.keymap === undefined ? {} : { keymap: options.keymap }),
    });
  }

  public get invitation(): InkbookEditorChromeProps["onboarding"] {
    return this.#enabled && this.#visible ? this.#invitation : undefined;
  }

  public withTourPreview(state: ToolbarState): ToolbarState {
    return { ...state, onboardingContextPreview: this.#tour.contextPreview };
  }

  public setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (!enabled) {
      this.#visible = false;
      this.#tour.showInvitation(false);
      this.#tour.close();
      return;
    }
    if (this.#offered || this.#dismissed || this.#options.onDismissOnboarding === undefined) return;
    this.#offered = true;
    this.#visible = true;
    this.#tour.showInvitation(true);
    this.#rememberInvitation();
  }

  public readonly open = (): void => {
    if (!this.#enabled) return;
    this.#tour.open(
      this.#root.querySelector<HTMLElement>('[data-inkbook-action="overflow"]') ?? undefined,
    );
    this.#dismiss();
  };

  public updateDismissed(dismissed: boolean): void {
    this.#dismissed = dismissed;
  }

  public dispose(): void {
    this.#enabled = false;
    this.#visible = false;
    this.#tour.dispose();
  }

  #dismiss(): void {
    this.#rememberInvitation();
    this.#visible = false;
    this.#tour.showInvitation(false);
    this.#options.onStateChanged();
  }

  #rememberInvitation(): void {
    if (this.#dismissed) return;
    try {
      this.#options.onDismissOnboarding?.();
      this.#dismissed = true;
    } catch {
      this.#options.onFeedback("onboarding-preference-failed");
    }
  }
}
