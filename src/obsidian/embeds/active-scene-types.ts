import type {
  InkbookDeviceSettingsV1,
  InkbookSettingsV2,
  StartupToolV1,
  ToolDefaultsV1,
} from "../../domain/settings/types";
import type { MenuFactoryPort } from "../menus/index";
import type { BrowserScrollElement } from "../scrolling/index";
import type { InkbookColorScheme } from "../theme/color-scheme";
import type { InkbookFeedbackCode } from "../feedback";
import type { ActiveEditorHistory } from "./active-editor/history";
import type { EditableDocumentModel } from "./vault-document-session";
import type { PresentationScrollRangeReserve } from "./transition-scroll-stability";

export interface ActiveInkbookSceneOptions {
  readonly backgroundSpacing: () => InkbookSettingsV2["pageDefaults"]["backgroundSpacing"];
  readonly defaults: ToolDefaultsV1;
  readonly deviceSettings: InkbookDeviceSettingsV1;
  readonly menuFactory?: MenuFactoryPort;
  readonly history: ActiveEditorHistory;
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
  readonly startupTool: StartupToolV1;
}
