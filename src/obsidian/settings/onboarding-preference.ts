import type { InkbookSettingsStore } from "./storage";

export interface OnboardingPreferencePort {
  claimInvitation(): boolean;
  dismiss(): void;
}

/** Consumes the invitation for one plugin session before attempting durable storage. */
export class OnboardingPreference implements OnboardingPreferencePort {
  #offered = false;

  public constructor(
    private readonly settings: Pick<
      InkbookSettingsStore,
      "getDeviceSettings" | "updateDeviceSettings"
    >,
  ) {}

  public claimInvitation(): boolean {
    if (this.#offered || this.settings.getDeviceSettings().onboardingDismissed) return false;
    this.#offered = true;
    return true;
  }

  public dismiss(): void {
    this.settings.updateDeviceSettings((value) => ({ ...value, onboardingDismissed: true }));
  }
}
