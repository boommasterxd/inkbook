import type {
  BackgroundFlyoutState,
  EditorFlyoutCallbacks,
  OverflowMenuState,
  ShapeId,
  StyleControl,
} from "./flyout-types";
import type { ToolbarLayoutStage } from "./toolbar-layout";
import type { ToolbarAction, ToolbarState } from "./toolbar-types";
import type { ToolbarStyleIconState } from "./style-icon";

export interface InkbookEditorChromeProps {
  readonly background: BackgroundFlyoutState;
  readonly callbacks: EditorFlyoutCallbacks;
  readonly canvasInput: HTMLElement | null;
  readonly layout: ToolbarLayoutStage;
  readonly leftHanded?: boolean;
  readonly onToolbarAction: (action: ToolbarAction) => void;
  readonly ownerDocument: Document;
  readonly overflowMenu: OverflowMenuState;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly selectedShape: ShapeId;
  readonly styleControls: readonly StyleControl[];
  readonly styleIcon: ToolbarStyleIconState;
  readonly toolbarState: ToolbarState;
}
