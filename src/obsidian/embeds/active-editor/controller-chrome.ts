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
import type { EditableDocumentModel } from "../document-session/vault-document-session";
import type { ActiveEditorMenuController } from "./controller-menu";
import type { ActiveEditorControllerOptions } from "./controller-types";
import { backgroundState } from "./controller-helpers";
import { ActiveEditorOnboarding } from "./onboarding";
import type { BrowserScrollElement } from "../../scrolling/index";

type ActiveEditorChromeDependencies = readonly [
  actions: ActiveEditorActions,
  background: ActiveEditorBackgroundSession,
  chromeState: ActiveEditorChromeState,
  styles: ActiveEditorStyleSession,
  openings: ActiveEditorControllerOptions,
];

type ActiveEditorChromeHandlers = readonly [
  activeTool: () => EditorTool,
  configureTool: (tool: EditorTool) => void,
];

export function createActiveEditorChrome(
  [actions, background, chromeState, styles, openings]: ActiveEditorChromeDependencies,
  [activeTool, configureTool]: ActiveEditorChromeHandlers,
  [menus, model, selectionSize, renderIcon]: readonly [
    ActiveEditorMenuController,
    EditableDocumentModel,
    () => number,
    InkbookEditorChromeProps["renderIcon"],
  ],
  scrollOwner: () => BrowserScrollElement,
): ActiveEditorOnboarding {
  const onboarding = new ActiveEditorOnboarding(openings, scrollOwner);
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
    onOpenTour: onboarding.open,
    onShapeChange: (shape) => configureTool(chromeState.selectShape(shape)),
    onStyleChange: (id, value) => styles.apply(activeTool(), id, value),
  };
  configureActiveEditorToolbarMenus(
    [menus, actions, chromeState, styles, model],
    [activeTool, selectionSize, callbacks, renderIcon],
  );
  return onboarding;
}

interface ActiveEditorChromeOptions {
  readonly onboarding?: InkbookEditorChromeProps["onboarding"];
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
    ...(options.onboarding === undefined ? {} : { onboarding: options.onboarding }),
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

interface ChromePresentationOptions {
  readonly state: readonly [ActiveEditorChromeState, ActiveEditorStyleSession];
  readonly activeTool: EditorTool;
  readonly leftHanded: boolean;
  readonly onToolbarAction: InkbookEditorChromeProps["onToolbarAction"];
  readonly ownerDocument: Document;
  readonly renderIcon: InkbookEditorChromeProps["renderIcon"];
  readonly toolbarState: ToolbarState;
  readonly onboarding?: InkbookEditorChromeProps["onboarding"];
}

export function createActiveEditorChromeProps({
  state: [chromeState, styles],
  activeTool,
  onboarding,
  ...props
}: ChromePresentationOptions): InkbookEditorChromeProps {
  const style = styles.presentation(activeTool);
  return createChromeProps({
    layout: chromeState.layout,
    ...props,
    selectionArea: style.selectionArea,
    selectedShape: chromeState.selectedShape,
    shapeIcon: style.shapeIcon,
    style,
    ...(onboarding === undefined ? {} : { onboarding }),
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
        get styleControls() {
          return style.controls;
        },
      };
    },
    handlers: callbacks,
    onOpenChange: (id) => chromeState.setFlyout(id),
    renderIcon,
  });
}
