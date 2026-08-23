import type { PageV1 } from "../../../domain/schema/public";
import type {
  InkbookEditorChromeProps,
  ShapeId,
  ToolbarLayoutStage,
  ToolbarState,
  StyleControl,
} from "../../../rendering/ui/index";
import { backgroundState } from "./controller-helpers";

export interface ActiveEditorChromeOptions {
  readonly canvasInput: HTMLElement;
  readonly layout: ToolbarLayoutStage;
  readonly leftHanded: boolean;
  readonly onBackgroundSpacingChange: InkbookEditorChromeProps["callbacks"]["onBackgroundSpacingChange"];
  readonly onBackgroundTypeChange: InkbookEditorChromeProps["callbacks"]["onBackgroundTypeChange"];
  readonly onOverflowAction: InkbookEditorChromeProps["callbacks"]["onOverflowAction"];
  readonly onShapeChange: (shape: ShapeId) => void;
  readonly onStyleChange: InkbookEditorChromeProps["callbacks"]["onStyleChange"];
  readonly onToolbarAction: InkbookEditorChromeProps["onToolbarAction"];
  readonly ownerDocument: Document;
  readonly overflowMenu: InkbookEditorChromeProps["overflowMenu"];
  readonly page: PageV1;
  readonly renderIcon: InkbookEditorChromeProps["renderIcon"];
  readonly selectedShape: ShapeId;
  readonly setFlyoutClosed: () => void;
  readonly styleControls: readonly StyleControl[];
  readonly toolbarState: ToolbarState;
}

export function createChromeProps(options: ActiveEditorChromeOptions): InkbookEditorChromeProps {
  return {
    background: backgroundState(options.page),
    callbacks: {
      onBackgroundSpacingChange: options.onBackgroundSpacingChange,
      onBackgroundTypeChange: options.onBackgroundTypeChange,
      onFlyoutClose: options.setFlyoutClosed,
      onOverflowAction: options.onOverflowAction,
      onShapeChange: options.onShapeChange,
      onStyleChange: options.onStyleChange,
    },
    canvasInput: options.canvasInput,
    layout: options.layout,
    leftHanded: options.leftHanded,
    onToolbarAction: options.onToolbarAction,
    ownerDocument: options.ownerDocument,
    overflowMenu: options.overflowMenu,
    renderIcon: options.renderIcon,
    selectedShape: options.selectedShape,
    styleControls: options.styleControls,
    toolbarState: options.toolbarState,
  };
}

export function overflowMenuState(
  arrange: InkbookEditorChromeProps["overflowMenu"]["arrange"],
  canEraseAll: boolean,
  hasSelection: boolean,
): InkbookEditorChromeProps["overflowMenu"] {
  return { arrange, canEraseAll, hasSelection };
}
