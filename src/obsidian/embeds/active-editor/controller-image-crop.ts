import { createEnglishLocalization } from "../../../domain/localization";
import { openCanvasImageCrop } from "../../images/canvas-image-crop";
import type { BrowserScrollElement } from "../../scrolling/index";
import type { ActiveEditorControllerOptions } from "./controller-types";
import type { ActiveImageSessionOptions } from "./image-session";

/** Presentation-local crop chrome uses the same guarded image mutation as imported dialog results. */
export function createCanvasImageCropOpening(
  controller: ActiveEditorControllerOptions,
  onActiveChanged: (active: boolean) => void,
  scrollOwner: () => BrowserScrollElement,
): ActiveImageSessionOptions["onCropImage"] {
  return (image, resource, signal) =>
    openCanvasImageCrop({
      container: controller.container,
      chromeHost: controller.container.parentElement ?? controller.container,
      scrollOwner,
      keymap: controller.keymap,
      image,
      resource,
      signal,
      renderer: controller.renderer,
      scheduler: controller.workScheduler,
      localization: controller.localization ?? createEnglishLocalization(),
      renderIcon: controller.renderIcon,
      readMotion: () => controller.deviceSettings.motion,
      onActiveChanged,
      subscribeChanges: (cancel) => controller.model.store.subscribe(cancel),
    });
}
