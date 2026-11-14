import { setIcon } from "obsidian";

import type { SvgSceneRenderer } from "../../../rendering/scene/index";
import { createOwnedMenuFactory } from "../../menus/index";
import type { BrowserScrollElement } from "../../scrolling/index";
import { ActiveEditorController } from "../active-editor/controller";
import type { ActiveEditorLayout } from "../active-editor/layout/layout";
import type { ElementSceneStore } from "../active-editor/scene-store";
import { applyActiveSceneZoomLayout } from "./active-scene-runtime";
import type { ActiveInkbookSceneOptions } from "./active-scene-types";

interface ActiveSceneControllerEnvironment {
  readonly container: HTMLDivElement;
  readonly layout: () => ActiveEditorLayout;
  readonly renderer: SvgSceneRenderer;
  readonly scrollOwner: BrowserScrollElement;
  readonly store: ElementSceneStore;
  readonly updateChrome: () => void;
}

export function createActiveSceneController(
  options: ActiveInkbookSceneOptions,
  environment: ActiveSceneControllerEnvironment,
): ActiveEditorController {
  const { container, layout, renderer, scrollOwner, store } = environment;
  return new ActiveEditorController({
    copyTextFieldsAsText: options.copyTextFieldsAsText ?? false,
    localization: options.localization,
    ...(options.textFonts === undefined ? {} : { textFonts: options.textFonts }),
    workScheduler: options.workScheduler,
    applyZoomLayout: (update) =>
      applyActiveSceneZoomLayout(layout(), update, options.hostZoomScroll, container),
    onNavigationLayout: (navigationLayout) => layout().adoptNavigationLayout(navigationLayout),
    reconcileTextLayout: (callback) => {
      if (options.hostZoomScroll?.afterLayout) options.hostZoomScroll.afterLayout(callback);
      else callback();
    },
    backgroundSpacing: options.backgroundSpacing,
    container,
    confirmEraseAll: options.confirmEraseAll,
    defaults: options.defaults,
    deviceSettings: options.deviceSettings,
    history: options.history,
    interruptLayoutForInput: () => layout().interruptForInput(),
    ...(options.keymap === undefined ? {} : { keymap: options.keymap }),
    ...(options.createPhoneSheetHost === undefined
      ? {}
      : { createPhoneSheetHost: options.createPhoneSheetHost }),
    menuFactory:
      options.menuFactory ??
      createOwnedMenuFactory({
        localization: options.localization,
        workScheduler: options.workScheduler,
        anchor: options.root,
        ...(options.keymap === undefined ? {} : { keymap: options.keymap }),
        ...(options.createPhoneSheetHost === undefined
          ? {}
          : { createPhoneSheetHost: options.createPhoneSheetHost }),
      }),
    model: options.model,
    onLock: options.onLock,
    onFeedback: options.onFeedback,
    onCopyEmbed: options.onCopyEmbed,
    onDeleteEmbed: options.onDeleteEmbed,
    onOpenSettings: options.onOpenSettings,
    onOpenFonts: options.onOpenFonts,
    onOpenShortcuts: options.onOpenShortcuts,
    onboardingPreference: options.onboardingPreference,
    onPageChanged: () => layout().pageChanged(),
    onPagePreviewFinish: (committed) => layout().finishPagePreview(committed),
    onPagePreview: (page) => layout().previewPage(page),
    onStateChanged: environment.updateChrome,
    renderIcon: (element, icon) => setIcon(element, icon),
    renderer,
    sceneStore: store,
    selectionMoveLayout: {
      begin: () => layout().beginSelectionMove(),
      currentHeight: () => layout().currentPageHeight(),
      finish: (committed, previewMaximumBottom, immediate) =>
        layout().finishSelectionMove(committed, previewMaximumBottom, immediate),
      updateBottom: (maximumBottom, immediate, sourceExtent) =>
        layout().updateSelectionMoveBottom(maximumBottom, immediate, sourceExtent),
    },
    scrollOwner,
    snapping: options.snapping,
    ...(options.holdToShape === undefined ? {} : { holdToShape: options.holdToShape }),
    startupTool: options.startupTool,
  });
}
