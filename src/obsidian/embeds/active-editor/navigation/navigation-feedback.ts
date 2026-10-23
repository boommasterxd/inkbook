import { reduceInput } from "../../../../editor/input/index";
import { sameNavigationLayout, type NavigationCursorLayout } from "./navigation-layout";
import type { ActiveEditorCameraUpdate, ActiveEditorNavigationOptions } from "./navigation-types";

type FeedbackOptions = Pick<ActiveEditorNavigationOptions, "getInput" | "setInput"> & {
  readonly applyCamera: NonNullable<ActiveEditorNavigationOptions["applyCamera"]>;
};

/** Retains only feedback actually applied, never an unmeasured camera assumption. */
export class NavigationFeedback {
  #camera: ActiveEditorCameraUpdate | undefined;
  #layout: NavigationCursorLayout | undefined;
  readonly #options: FeedbackOptions;

  public constructor(options: FeedbackOptions) {
    this.#options = options;
  }

  public reset(): void {
    this.#camera = undefined;
    this.#layout = undefined;
  }

  public apply(
    camera: ActiveEditorCameraUpdate,
    layout: NavigationCursorLayout,
    fitZoom: number,
  ): void {
    const input = this.#options.getInput();
    const inputChanged = input.zoom !== camera.zoom || input.fitZoom !== fitZoom;
    if (inputChanged) {
      this.#options.setInput(
        reduceInput(input, { type: "configure", fitZoom, zoom: camera.zoom }).state,
      );
    }
    if (
      !inputChanged &&
      this.#camera?.x === camera.x &&
      this.#camera.zoom === camera.zoom &&
      sameNavigationLayout(this.#layout, layout)
    )
      return;
    this.#options.applyCamera(camera, layout);
    this.#camera = camera;
    this.#layout = layout;
  }
}
