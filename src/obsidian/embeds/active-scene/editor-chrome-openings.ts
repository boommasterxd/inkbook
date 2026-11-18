import type { PhoneSheetNavigation } from "../../menus/panels/panel-page";
import type { OnboardingPreferencePort } from "../../settings/onboarding-preference";
import type {
  ImageCropV3,
  ImageElementV3,
  ImageResourceV3,
  PageV1,
} from "../../../domain/schema/public";
import type { ImageInsertionPlacement } from "../../../domain/images/image-insertion-size";

export interface ImportedImageBatch {
  readonly resources: readonly ImageResourceV3[];
  readonly source: "image" | "pdf";
  readonly placement?: ImageInsertionPlacement;
}

export interface ImageImportRequest {
  readonly page: Pick<PageV1, "innerWidth" | "margin" | "background">;
  readonly centerX: number;
  readonly retainedResources?: () => readonly ImageResourceV3[] | undefined;
  readonly submit: (
    batch: ImportedImageBatch,
    signal: AbortSignal,
  ) => Promise<"committed" | "capacity" | "unavailable">;
}

export interface EditorChromeOpenings {
  readonly onImportImages?:
    | ((signal: AbortSignal, ownerWindow: Window, request: ImageImportRequest) => Promise<void>)
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
