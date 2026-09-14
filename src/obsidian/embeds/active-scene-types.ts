import type { PhoneSheetHostPort } from "../menus/phone-sheet-host";
import type {
  InkbookDeviceSettingsV2,
  InkbookSettingsV4,
  SnappingSettingsV1,
  StartupToolV1,
  ToolDefaultsV1,
} from "../../domain/settings/types";
import type { MenuFactoryPort } from "../menus/index";
import type { BrowserScrollElement } from "../scrolling/index";
import type { InkbookColorScheme } from "../theme/color-scheme";
import type { InkbookFeedbackCode } from "../feedback";
import type { ActiveEditorHistory } from "./active-editor/history";
import type { Keymap } from "obsidian";
import type { EditableDocumentModel } from "./vault-document-session";
import type { PresentationScrollRangeReserve } from "./transition-scroll-stability";
import type { EditorChromeOpenings } from "./editor-chrome-openings";

export interface ActiveInkbookSceneOptions extends EditorChromeOpenings {
  readonly backgroundSpacing: () => InkbookSettingsV4["pageDefaults"]["backgroundSpacing"];
  readonly defaults: ToolDefaultsV1;
  readonly deviceSettings: InkbookDeviceSettingsV2;
  readonly menuFactory?: MenuFactoryPort;
  readonly history: ActiveEditorHistory;
  readonly createPhoneSheetHost?: () => PhoneSheetHostPort;
  readonly keymap?: Pick<Keymap, "popScope" | "pushScope">;
  readonly model: EditableDocumentModel;
  readonly onLock: () => void;
  readonly onFeedback: (code: InkbookFeedbackCode) => void;
  readonly onCopyEmbed: () => void;
  readonly onDeleteEmbed: () => void;
  readonly onFirstStrokeCommitted?: () => void;
  readonly root: HTMLElement;
  readonly sliceBudgetMs: () => number;
  readonly preview?: HTMLElement;
  readonly scrollRangeReserve?: PresentationScrollRangeReserve;
  readonly setPreviewSource?: (source: string) => Promise<void>;
  readonly setPreviewAspectRatio?: (aspectRatio: number) => void;
  readonly scheme: InkbookColorScheme;
  readonly scrollOwner?: () => BrowserScrollElement | null;
  readonly snapping: SnappingSettingsV1;
  readonly startupTool: StartupToolV1;
}
