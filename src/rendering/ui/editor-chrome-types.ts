import type { ShapeId } from "./flyout-types";
import type { ToolbarLayoutStage } from "./toolbar-layout";
import type { ToolbarAction, ToolbarState } from "./toolbar-types";
import type { ToolbarStyleIconState } from "./style-icon";
import type { ActiveShapeIconState } from "./icon-ids";

export interface InkbookEditorChromeProps {
  readonly layout: ToolbarLayoutStage;
  readonly leftHanded?: boolean;
  readonly onToolbarAction: (action: ToolbarAction, trigger: HTMLButtonElement) => void;
  readonly ownerDocument: Document;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly selectedShape: ShapeId;
  readonly shapeIcon: ActiveShapeIconState;
  readonly styleIcon: ToolbarStyleIconState;
  readonly toolbarState: ToolbarState;
}
