import type { SelectionFrameSession } from "../../../editor/selection/public";
import { BUILT_IN_TEXT_FONT_OPTIONS } from "../../menus/text-style-controls";
import { createControllerStyleSession } from "./controller-interactions";
import { createControllerTextSession } from "./controller-text";
import type { ActiveEditorControllerOptions } from "./controller-types";
import type { ActiveEditorNavigation } from "./navigation/navigation";
import type { PreparedElementHistory } from "./prepared-element-history";
import type { ActiveTextSession } from "./text-session";
import type { ActiveEditorMenuController } from "./controller-menu";
import { createSelectedTextToolbarIcon, textToolbarIcon } from "./text-toolbar-icon";
import { TextHandleInput } from "./text-handle-input";
import type { ActiveEditorHandleInteraction } from "./previews/handle-interaction";
import type { ActiveEditorPointerController } from "./input/controller-pointer";
import type { ActivePointerCaptureOwner } from "./input/pointer-capture";
import { TextEntryHandoff } from "./text-entry-handoff";
import { TextHandleHover } from "./text-handle-hover";

interface ControllerTextBindings {
  readonly menus: Pick<
    ActiveEditorMenuController,
    "configureTextEditing" | "closeToolbar" | "isStyleOpen" | "occlusionTop"
  >;
  readonly navigation: ActiveEditorNavigation;
  readonly handles: ActiveEditorHandleInteraction;
  readonly pointer: () => ActiveEditorPointerController;
  readonly captures: ActivePointerCaptureOwner;
  readonly selection: () => ReadonlySet<string>;
  readonly setSelection: (selection: ReadonlySet<string>) => void;
  readonly selectionFrames: SelectionFrameSession;
  readonly preparedHistory: PreparedElementHistory;
  readonly isEnabled: () => boolean;
  readonly onStateChanged: () => void;
  readonly onSelectionGeometryChanged: () => void;
  readonly onFinished: () => void;
}

/** Composes one authoritative text session with its shared Style-panel overrides. */
export function createControllerTextBindings(
  options: ActiveEditorControllerOptions,
  bindings: ControllerTextBindings,
) {
  let session: ActiveTextSession | undefined;
  let handleInput: TextHandleInput | undefined;
  let entry: TextEntryHandoff | undefined;
  let hover: TextHandleHover | undefined;
  const closeSourceStyle = () => {
    if (!bindings.menus.isStyleOpen) return false;
    bindings.menus.closeToolbar("immediate");
    return true;
  };
  const selectedIcon = createSelectedTextToolbarIcon(options.model.store, bindings.selection);
  const fontOptions = () => [
    ...BUILT_IN_TEXT_FONT_OPTIONS,
    ...(options.textFonts?.choices() ?? []),
  ];
  const styles = createControllerStyleSession(options, {
    ...bindings,
    preview: {
      renderer: options.renderer,
      pageToScreen: (point) => bindings.navigation.localPointFromPage(point),
      zoom: () => bindings.navigation.zoom,
      workScheduler: options.workScheduler,
      layout: options.selectionMoveLayout,
    },
    controlsOverride: () => session?.controls(styles.localization.t, fontOptions()),
    iconOverride: (tool) => {
      const summary = session?.styleSummary();
      return summary ? textToolbarIcon(summary) : selectedIcon(tool);
    },
    applyOverride: (id, value) => {
      if (!session?.active) return false;
      if (session.applyStyle(id, value)) session.focusInput();
      return true;
    },
    fontOptions,
  });
  const text = createControllerTextSession(options, {
    ...bindings,
    onStateChanged: () => {
      hover?.setDocument(session?.inputElement?.ownerDocument ?? options.renderer.textDocument);
      bindings.onStateChanged();
    },
    onHeightChanged: (height, basis) =>
      bindings.handles.setTextEditingHeight(basis.id, height, basis),
    defaults: () => styles.defaults.text,
    onPointerDown: (event) => {
      closeSourceStyle();
      return handleInput?.pointerDown(event) || entry?.claim(event) || false;
    },
    onEscape: closeSourceStyle,
    occlusionTop: () => bindings.menus.occlusionTop,
  });
  session = text.session;
  entry = new TextEntryHandoff({
    store: options.model.store,
    navigation: bindings.navigation,
    ownerWindow: options.container.ownerDocument.defaultView!,
    scheduler: options.workScheduler,
    edit: (id, position) => text.session.edit(id, position),
    coordinates: () => text.session.inputCoordinates,
  });
  ({ handleInput, hover } = createTextGeometryInput(options, bindings, session));
  configureTextEditingMenu(options, bindings, text.session);
  return {
    styles,
    ...text,
    handleInput,
    activateElement: (id: string) => {
      if (!bindings.isEnabled() || text.session.active) return;
      const selection = bindings.selection();
      if (selection.size !== 1 || !selection.has(id)) return;
      const element = options.model.store.get(id)?.element;
      if (element?.kind === "text") entry.activate(id, element.source.length);
    },
    releaseInput: () => {
      hover.dispose();
      handleInput.dispose();
      entry.dispose();
      text.releaseInput();
    },
    pointerDown: (event: PointerEvent) => {
      if (!text.session.active && !entry.pending) return false;
      if (handleInput.pointerDown(event)) return true;
      if (entry.claim(event)) {
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      if (!text.session.active) return false;
      event.preventDefault();
      event.stopPropagation();
      void text.session.finish();
      return true;
    },
  };
}

function createTextGeometryInput(
  options: ActiveEditorControllerOptions,
  bindings: ControllerTextBindings,
  session: ActiveTextSession,
) {
  const shared = {
    handles: bindings.handles,
    navigation: bindings.navigation,
    ownerWindow: options.container.ownerDocument.defaultView!,
    scheduler: options.workScheduler,
  };
  return {
    handleInput: new TextHandleInput({
      ...shared,
      session,
      coordinates: () => session.inputCoordinates,
      pointer: bindings.pointer,
      captures: bindings.captures,
    }),
    hover: new TextHandleHover({
      ...shared,
      document: options.renderer.textDocument,
      active: () => session.active && bindings.isEnabled(),
      coordinates: () => session.inputCoordinates,
    }),
  };
}

function configureTextEditingMenu(
  options: Pick<ActiveEditorControllerOptions, "model">,
  bindings: ControllerTextBindings,
  session: ActiveTextSession,
): void {
  bindings.menus.configureTextEditing({
    focusTarget: () => session.inputElement,
    onOcclusionChanged: (top) => {
      if (top === undefined) session.reserveSourceBottom();
      session.requestCaretReveal();
    },
    selectedId: () => {
      if (!bindings.isEnabled()) return undefined;
      const selection = bindings.selection();
      if (selection.size !== 1) return undefined;
      const id = selection.values().next().value;
      return id !== undefined && options.model.store.get(id)?.element.kind === "text"
        ? id
        : undefined;
    },
    onEdit: (id) => {
      void session.edit(id);
    },
  });
}
