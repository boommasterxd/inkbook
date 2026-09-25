import type { PhoneSheetHostPort } from "../../menus/phone-sheet-host";
import type {
  InkbookDeviceSettingsV2,
  SnappingSettingsV1,
  StartupToolV1,
  ToolDefaultsV1,
} from "../../../domain/settings/types";
import type { SvgSceneRenderer } from "../../../rendering/scene/index";
import type { MenuFactoryPort } from "../../menus/index";
import type { BrowserScrollElement } from "../../scrolling/index";
import type { InkbookFeedbackCode } from "../../feedback";
import type { EditableDocumentModel } from "../vault-document-session";
import type { PageV1 } from "../../../domain/schema/public";
import type { ElementSceneStore } from "./scene-store";
import type { ActiveEditorZoomLayoutUpdate } from "./navigation";
import type { BackgroundSpacingDefaults } from "./controller-helpers";
import type { ActiveEditorHistory } from "./history";
import type { Keymap } from "obsidian";
import type { EditorChromeOpenings } from "../editor-chrome-openings";

export interface ActiveEditorControllerOptions extends EditorChromeOpenings {
  readonly container: HTMLElement;
  readonly applyZoomLayout: (update: ActiveEditorZoomLayoutUpdate) => number | void;
  readonly backgroundSpacing: () => BackgroundSpacingDefaults;
  readonly defaults: ToolDefaultsV1;
  readonly deviceSettings: InkbookDeviceSettingsV2;
  readonly interruptLayoutForInput: () => void;
  readonly createPhoneSheetHost?: () => PhoneSheetHostPort;
  readonly keymap?: Pick<Keymap, "popScope" | "pushScope">;
  readonly history: ActiveEditorHistory;
  readonly menuFactory: MenuFactoryPort;
  readonly model: EditableDocumentModel;
  readonly onLock: () => void;
  readonly onFeedback: (code: InkbookFeedbackCode) => void;
  readonly onCopyEmbed: () => void;
  readonly onDeleteEmbed: () => void;
  readonly onPageChanged: () => void;
  readonly onPagePreviewFinish: (committed: boolean) => void;
  readonly onPagePreview: (page: PageV1) => void;
  readonly onStateChanged: () => void;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly renderer: SvgSceneRenderer;
  readonly sliceBudgetMs?: () => number;
  readonly sceneStore: ElementSceneStore;
  readonly selectionMoveLayout: {
    begin(): void;
    currentHeight?(): number | undefined;
    finish(committed: boolean, previewMaximumBottom?: number): void;
    updateBottom(maximumBottom: number): void;
  };
  readonly scrollOwner: BrowserScrollElement;
  readonly snapping: SnappingSettingsV1;
  readonly startupTool: StartupToolV1;
}
