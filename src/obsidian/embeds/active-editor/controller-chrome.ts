import type { PageV1 } from "../../../domain/schema/public";
import type { EditorTool } from "../../../editor/input/index";
import type {
  InkbookEditorChromeProps,
  ShapeId,
  ToolbarLayoutStage,
  ToolbarState,
  StyleControl,
} from "../../../rendering/ui/index";
import type { ActiveEditorBackgroundSession } from "./background-session";
import type { ActiveEditorActions } from "./controller-actions";
import type { ActiveEditorChromeState } from "./controller-chrome-state";
import { backgroundState } from "./controller-helpers";
import type { ActiveEditorStyleSession } from "./style-session";

type ActiveEditorChromeDependencies = readonly [
  actions: ActiveEditorActions,
  background: ActiveEditorBackgroundSession,
  chromeState: ActiveEditorChromeState,
  styles: ActiveEditorStyleSession,
];

type ActiveEditorChromeHandlers = readonly [
  activeTool: () => EditorTool,
  configureTool: (tool: EditorTool) => void,
];

export function createChromeCallbacks(
  [actions, background, chromeState, styles]: ActiveEditorChromeDependencies,
  [activeTool, configureTool]: ActiveEditorChromeHandlers,
): InkbookEditorChromeProps["callbacks"] {
  return {
    onBackgroundSpacingChange: (spacing) => background.changeSpacing(spacing),
    onBackgroundTypeChange: (type) => background.changeType(type),
    onFlyoutClose: () => chromeState.setFlyout(null),
    onOverflowAction: (action) => {
      chromeState.setFlyout(null);
      if (actions.isAvailable(action)) actions.execute(action);
    },
    onShapeChange: (shape) => configureTool(chromeState.selectShape(shape)),
    onStyleChange: (id, value) => styles.apply(activeTool(), id, value),
  };
}

export interface ActiveEditorChromeOptions {
  readonly canvasInput: HTMLElement;
  readonly callbacks: InkbookEditorChromeProps["callbacks"];
  readonly layout: ToolbarLayoutStage;
  readonly leftHanded: boolean;
  readonly onToolbarAction: InkbookEditorChromeProps["onToolbarAction"];
  readonly ownerDocument: Document;
  readonly overflowMenu: InkbookEditorChromeProps["overflowMenu"];
  readonly page: PageV1;
  readonly renderIcon: InkbookEditorChromeProps["renderIcon"];
  readonly selectedShape: ShapeId;
  readonly style: {
    readonly controls: readonly StyleControl[];
    readonly icon: InkbookEditorChromeProps["styleIcon"];
  };
  readonly toolbarState: ToolbarState;
}

export function createChromeProps(options: ActiveEditorChromeOptions): InkbookEditorChromeProps {
  return {
    background: backgroundState(options.page),
    callbacks: options.callbacks,
    canvasInput: options.canvasInput,
    layout: options.layout,
    leftHanded: options.leftHanded,
    onToolbarAction: options.onToolbarAction,
    ownerDocument: options.ownerDocument,
    overflowMenu: options.overflowMenu,
    renderIcon: options.renderIcon,
    selectedShape: options.selectedShape,
    styleControls: options.style.controls,
    styleIcon: options.style.icon,
    toolbarState: options.toolbarState,
  };
}

export function overflowMenuState(
  actions: ActiveEditorActions,
  hasSelection: boolean,
): InkbookEditorChromeProps["overflowMenu"] {
  return {
    arrange: actions.arrangeAvailability(),
    canEraseAll: actions.isAvailable("erase-all"),
    hasSelection,
  };
}
