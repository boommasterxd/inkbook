import type { NavigationCursorLayout } from "./navigation-layout";
import type { InputState } from "../../../editor/input/index";
import type { SvgSceneRenderer } from "../../../rendering/scene/index";
import type { BrowserScrollElement } from "../../scrolling/index";

export interface ActiveEditorZoomLayoutUpdate {
  readonly blockSize: number;
  readonly zoom: number;
}

export interface ActiveEditorCameraUpdate {
  readonly x: number;
  readonly zoom: number;
}

export interface ActiveEditorNavigationOptions {
  readonly onNavigationActive?: (active: boolean) => void;
  readonly activePageHeight: () => number;
  readonly applyCamera?: (
    camera: ActiveEditorCameraUpdate,
    layout?: NavigationCursorLayout,
  ) => void;
  readonly applyZoomLayout: (update: ActiveEditorZoomLayoutUpdate) => number | void;
  readonly container: HTMLElement;
  readonly renderer: SvgSceneRenderer;
  readonly scrollOwner: BrowserScrollElement;
  readonly getInput: () => InputState;
  readonly setInput: (input: InputState) => void;
}

export interface ActiveEditorViewState {
  readonly cameraX: number;
  readonly zoom: number;
}

export interface ActiveEditorWheelInput {
  readonly clientX: number;
  readonly clientY: number;
  readonly ctrlKey?: boolean;
  readonly deltaMode: number;
  readonly deltaX?: number;
  readonly deltaY: number;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}
