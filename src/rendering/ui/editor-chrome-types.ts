import type { ToolbarLayoutStage } from "./toolbar-layout";
import type { ShapeId, ToolbarAction, ToolbarState } from "./toolbar-types";
import type { ToolbarStyleIconState } from "./style-icon";
import type { ActiveShapeIconState } from "./icon-ids";
import type { SelectionAreaV1 } from "../../domain/settings/types";

export interface InkbookEditorChromeProps {
  readonly onboarding?: {
    readonly container: HTMLElement;
    readonly onStart: () => void;
    readonly onDismiss: () => void;
  };
  readonly layout: ToolbarLayoutStage;
  readonly leftHanded?: boolean;
  readonly onToolbarAction: (action: ToolbarAction, trigger: HTMLButtonElement) => void;
  readonly ownerDocument: Document;
  readonly renderIcon: (element: HTMLElement, icon: string) => void;
  readonly selectionArea: SelectionAreaV1;
  readonly selectedShape: ShapeId;
  readonly shapeIcon: ActiveShapeIconState;
  readonly styleIcon: ToolbarStyleIconState;
  readonly toolbarState: ToolbarState;
}
