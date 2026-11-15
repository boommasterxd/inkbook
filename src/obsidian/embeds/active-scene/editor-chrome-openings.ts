import type { PhoneSheetNavigation } from "../../menus/panels/panel-page";
import type { OnboardingPreferencePort } from "../../settings/onboarding-preference";
import type { ImageCropV3, ImageElementV3, ImageResourceV3 } from "../../../domain/schema/public";

export interface ImportedImageBatch {
  readonly resources: readonly ImageResourceV3[];
  readonly source: "image" | "pdf";
}

export interface EditorChromeOpenings {
  readonly onImportImages?:
    | ((signal: AbortSignal, ownerWindow: Window) => Promise<ImportedImageBatch | undefined>)
    | undefined;
  readonly onCropImage?:
    | ((
        image: ImageElementV3,
        resource: ImageResourceV3,
        signal: AbortSignal,
        ownerWindow: Window,
      ) => Promise<ImageCropV3 | undefined>)
    | undefined;
  readonly onOpenFonts?: ((trigger: HTMLButtonElement) => void) | undefined;
  readonly onboardingPreference?: OnboardingPreferencePort | undefined;
  readonly confirmEraseAll?: ((signal: AbortSignal) => Promise<boolean>) | undefined;
  readonly onOpenSettings: (navigation?: PhoneSheetNavigation) => void;
  readonly onOpenShortcuts: (navigation?: PhoneSheetNavigation) => void;
}
