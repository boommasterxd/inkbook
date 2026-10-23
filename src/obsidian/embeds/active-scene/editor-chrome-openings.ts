import type { PhoneSheetNavigation } from "../../menus/panels/panel-page";
export interface EditorChromeOpenings {
  readonly confirmEraseAll?: ((signal: AbortSignal) => Promise<boolean>) | undefined;
  readonly onOpenSettings: (navigation?: PhoneSheetNavigation) => void;
  readonly onOpenShortcuts: (navigation?: PhoneSheetNavigation) => void;
}
