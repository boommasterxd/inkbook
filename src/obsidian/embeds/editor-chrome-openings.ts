import type { PhoneSheetNavigation } from "../menus/panel-page";
export interface EditorChromeOpenings {
  readonly confirmEraseAll?: ((signal: AbortSignal) => Promise<boolean>) | undefined;
  readonly onOpenSettings: (navigation?: PhoneSheetNavigation) => void;
  readonly onOpenShortcuts: (navigation?: PhoneSheetNavigation) => void;
}
