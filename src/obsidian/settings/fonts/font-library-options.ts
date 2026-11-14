import type { Localization } from "../../../domain/localization";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { LibraryFontFace, VaultFontLibrary } from "../../fonts/vault-font-library";
import type { NativeControlFeedbackOptions } from "../../menus/feedback/native-control-feedback";

export interface FontLibrarySettingsOptions extends NativeControlFeedbackOptions {
  readonly localization: Localization;
  readonly library: VaultFontLibrary;
  readonly scheduler: WorkScheduler | ((ownerWindow: Window | null) => WorkScheduler);
  readonly changed: () => void;
  readonly confirmRemove: (face: LibraryFontFace, signal: AbortSignal) => Promise<boolean>;
  readonly mutateDialogLayout?: (update: () => void) => void;
}

/** Keeps nested font controls inside their dialog's single intrinsic-height transaction. */
export function mutateFontLibraryDialog(
  options: Pick<FontLibrarySettingsOptions, "mutateDialogLayout">,
  update: () => void,
): void {
  if (options.mutateDialogLayout === undefined) update();
  else options.mutateDialogLayout(update);
}
