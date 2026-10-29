import type { PhoneSheetNavigation } from "../../menus/panels/panel-page";
import type { OnboardingPreferencePort } from "../../settings/onboarding-preference";
export interface EditorChromeOpenings {
  readonly onboardingPreference?: OnboardingPreferencePort | undefined;
  readonly confirmEraseAll?: ((signal: AbortSignal) => Promise<boolean>) | undefined;
  readonly onOpenSettings: (navigation?: PhoneSheetNavigation) => void;
  readonly onOpenShortcuts: (navigation?: PhoneSheetNavigation) => void;
}
