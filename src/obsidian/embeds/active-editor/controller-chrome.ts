import type { EditorTool } from "../../../editor/input/index";
import type {
  InkbookEditorChromeProps,
  ShapeId,
  ToolbarLayoutStage,
  ToolbarState,
} from "../../../rendering/ui/index";
import type { EditorMenuCallbacks, OverflowMenuState } from "../../menus/editor-menu-types";
import type { ActiveEditorBackgroundSession } from "./background-session";
import type { ActiveEditorActions } from "./controller-actions";
import type { ActiveEditorChromeState } from "./controller-chrome-state";
import type { ActiveEditorStyleSession } from "./style-session";
import type { EditableDocumentModel } from "../vault-document-session";
import type { ActiveEditorMenuController } from "./controller-menu";
import type { ActiveEditorControllerOptions } from "./controller-types";
import { backgroundState } from "./controller-helpers";

type ActiveEditorChromeDependencies = readonly [
  actions: ActiveEditorActions,
  background: ActiveEditorBackgroundSession,
  chromeState: ActiveEditorChromeState,
  styles: ActiveEditorStyleSession,
  openings: Pick<ActiveEditorControllerOptions, "onOpenSettings" | "onOpenShortcuts">,
];

type ActiveEditorChromeHandlers = readonly [
  activeTool: () => EditorTool,
  configureTool: (tool: EditorTool) => void,
];

export function createChromeCallbacks(
  [actions, background, chromeState, styles, openings]: ActiveEditorChromeDependencies,
  [activeTool, configureTool]: ActiveEditorChromeHandlers,
  [menus, model, selectionSize, renderIcon]: readonly [
    ActiveEditorMenuController,
    EditableDocumentModel,
    () => number,
    InkbookEditorChromeProps["renderIcon"],
  ],
): EditorMenuCallbacks {
  const callbacks: EditorMenuCallbacks = {
    onBackgroundSpacingChange: (spacing) => background.changeSpacing(spacing),
    onBackgroundSpacingPreview: (spacing) => background.previewSpacing(spacing),
    onBackgroundTypeChange: (type) => background.changeType(type),
    onOverflowAction: (action) => {
      chromeState.setFlyout(null);
      if (actions.isAvailable(action)) actions.execute(action);
    },
    onOpenSettings: openings.onOpenSettings,
    onOpenShortcuts: openings.onOpenShortcuts,
    onShapeChange: (shape) => configureTool(chromeState.selectShape(shape)),
    onStyleChange: (id, value) => styles.apply(activeTool(), id, value),
  };
  configureActiveEditorToolbarMenus(
    [menus, actions, chromeState, styles, model],
    [activeTool, selectionSize, callbacks, renderIcon],
  );
  return callbacks;
}

interface ActiveEditorChromeOptions {
  readonly layout: ToolbarLayoutStage;
  readonly leftHanded: boolean;
  readonly onToolbarAction: InkbookEditorChromeProps["onToolbarAction"];
  readonly ownerDocument: Document;
  readonly renderIcon: InkbookEditorChromeProps["renderIcon"];
  readonly selectionArea: InkbookEditorChromeProps["selectionArea"];
  readonly selectedShape: ShapeId;
  readonly shapeIcon: InkbookEditorChromeProps["shapeIcon"];
  readonly style: {
    readonly icon: InkbookEditorChromeProps["styleIcon"];
  };
  readonly toolbarState: ToolbarState;
}

function createChromeProps(options: ActiveEditorChromeOptions): InkbookEditorChromeProps {
  return {
    layout: options.layout,
    leftHanded: options.leftHanded,
    onToolbarAction: options.onToolbarAction,
    ownerDocument: options.ownerDocument,
    renderIcon: options.renderIcon,
    selectionArea: options.selectionArea,
    selectedShape: options.selectedShape,
    shapeIcon: options.shapeIcon,
    styleIcon: options.style.icon,
    toolbarState: options.toolbarState,
  };
}

export function createActiveEditorChromeProps(
  [chromeState, styles]: readonly [ActiveEditorChromeState, ActiveEditorStyleSession],
  [activeTool, leftHanded, onToolbarAction, ownerDocument, renderIcon, toolbarState]: readonly [
    EditorTool,
    boolean,
    InkbookEditorChromeProps["onToolbarAction"],
    Document,
    InkbookEditorChromeProps["renderIcon"],
    ToolbarState,
  ],
): InkbookEditorChromeProps {
  const style = styles.presentation(activeTool);
  return createChromeProps({
    layout: chromeState.layout,
    leftHanded,
    onToolbarAction,
    ownerDocument,
    renderIcon,
    selectionArea: style.selectionArea,
    selectedShape: chromeState.selectedShape,
    shapeIcon: style.shapeIcon,
    style,
    toolbarState,
  });
}

function overflowMenuState(actions: ActiveEditorActions, hasSelection: boolean): OverflowMenuState {
  return {
    arrange: actions.arrangeAvailability(),
    canEraseAll: actions.isAvailable("erase-all"),
    hasSelection,
  };
}

function configureActiveEditorToolbarMenus(
  [menus, actions, chromeState, styles, model]: readonly [
    ActiveEditorMenuController,
    ActiveEditorActions,
    ActiveEditorChromeState,
    ActiveEditorStyleSession,
    EditableDocumentModel,
  ],
  [activeTool, selectionSize, callbacks, renderIcon]: readonly [
    () => EditorTool,
    () => number,
    EditorMenuCallbacks,
    InkbookEditorChromeProps["renderIcon"],
  ],
): void {
  menus.configureToolbar({
    getState: () => {
      const style = styles.presentation(activeTool());
      return {
        background: backgroundState(model.page),
        overflow: overflowMenuState(actions, selectionSize() > 0),
        selectedShape: chromeState.selectedShape,
        shapeIcon: style.shapeIcon,
        styleControls: style.controls,
      };
    },
    handlers: callbacks,
    onOpenChange: (id) => chromeState.setFlyout(id),
    renderIcon,
  });
}
