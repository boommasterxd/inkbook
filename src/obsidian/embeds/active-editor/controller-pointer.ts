import {
  classifyPointerDown,
  isValidInputPoint,
  isValidPointerSample,
  type InputAction,
  type InputState,
  type PointerSample,
} from "../../../editor/input/index";
import type { SvgSceneRenderer } from "../../../rendering/scene/index";

import type { CoalescedPointerInput } from "./coalesced-input";
import { selectionTargetAt } from "./controller-elements";
import { isMacPlatform, normalizePointerType } from "./controller-helpers";
import type { ActiveEditorHandleInteraction } from "./handle-interaction";
import type { ActiveEditorMenuController } from "./controller-menu";
import type { ActiveEditorNavigation } from "./navigation";
import type { ElementSceneStore } from "./scene-store";

export interface ActiveEditorPointerOptions {
  readonly coalesced: CoalescedPointerInput;
  readonly capturePointer: (pointerId: number) => void;
  readonly beginHandlePointer: (pointerType: PointerSample["pointerType"]) => void;
  readonly dispatch: (action: InputAction) => void;
  readonly getInput: () => InputState;
  readonly finishHandlePointer: () => void;
  readonly handles: ActiveEditorHandleInteraction;
  readonly interruptForInput: () => void;
  readonly isEnabled: () => boolean;
  readonly menus: ActiveEditorMenuController;
  readonly navigation: ActiveEditorNavigation;
  readonly ownerWindow: Window;
  readonly renderer: SvgSceneRenderer;
  readonly releasePointer: (pointerId: number) => void;
  readonly sceneStore: ElementSceneStore;
  readonly selection: () => ReadonlySet<string>;
  readonly setLastPointer: (page: PointerSample, screen: PointerSample) => void;
}

export class ActiveEditorPointerController {
  readonly #options: ActiveEditorPointerOptions;

  public constructor(options: ActiveEditorPointerOptions) {
    this.#options = options;
  }

  public handleContextMenu(event: MouseEvent): void {
    if (!this.#options.isEnabled()) return;
    const screenPoint = this.#options.navigation.localScreenPoint(event);
    const point = this.#options.navigation.pagePointFromScreen(screenPoint);
    if (!isValidInputPoint(point)) return;
    const pointer = {
      pointerId: -1,
      pointerType: "mouse" as const,
      pressure: 0,
    };
    this.#options.setLastPointer({ ...point, ...pointer }, { ...screenPoint, ...pointer });
    const target = selectionTargetAt(
      this.#options.sceneStore,
      this.#options.selection(),
      point,
      "mouse",
      this.#options.navigation.zoom,
    );
    this.#options.menus.dispatchFromEvent(event, () =>
      this.#options.dispatch({
        type: "context-menu",
        source: "pointer",
        ...screenPoint,
        ...(target === undefined ? {} : { target }),
      }),
    );
    event.preventDefault();
  }

  public handlePointerCancel(event: PointerEvent): void {
    if (!this.#options.isEnabled()) return;
    if (this.#options.handles.cancel(event.pointerId)) {
      this.#releasePointer(event.pointerId);
      this.#options.finishHandlePointer();
      return;
    }
    this.#options.dispatch({ type: "pointer-cancel", pointerId: event.pointerId });
  }

  public handlePointerDown(event: PointerEvent): void {
    if (!this.#options.isEnabled()) return;
    this.#options.renderer.interruptMotionForPointerDown();
    const classification = classifyPointerDown({
      button: event.button,
      buttons: event.buttons,
      controlKey: event.ctrlKey,
      controlOrMeta: event.ctrlKey || event.metaKey,
      isMacPlatform: isMacPlatform(this.#options.ownerWindow.navigator),
      isPrimary: event.isPrimary,
      pointerType: normalizePointerType(event.pointerType),
    });
    this.#options.interruptForInput();
    if (!this.#options.navigation.beginGestureGeometry()) return;
    const pointer = this.#options.navigation.screenPointer(event);
    if (!isValidPointerSample(pointer)) {
      this.#options.navigation.finish();
      return;
    }
    const pagePointer = this.#options.navigation.pageSample(pointer);
    this.#options.setLastPointer(pagePointer, pointer);
    if (classification.handleEligible && this.#options.handles.pointerDown(pagePointer)) {
      this.#options.beginHandlePointer(pagePointer.pointerType);
      this.#options.capturePointer(event.pointerId);
      event.preventDefault();
      return;
    }
    const target = selectionTargetAt(
      this.#options.sceneStore,
      this.#options.selection(),
      pagePointer,
      pointer.pointerType,
      this.#options.navigation.zoom,
    );
    this.#options.menus.dispatchFromEvent(
      classification.isPlatformContextClick ? event : undefined,
      () =>
        this.#options.dispatch({
          type: "pointer-down",
          ...pointer,
          button: event.button,
          buttons: event.buttons,
          controlOrMeta: event.ctrlKey || event.metaKey,
          isPlatformContextClick: classification.isPlatformContextClick,
          penRole: classification.penRole,
          shift: event.shiftKey,
          ...(target === undefined ? {} : { target }),
        }),
    );
    if (this.#options.getInput().interaction !== undefined) event.preventDefault();
  }

  public handlePointerMove(event: PointerEvent): void {
    const pointer = this.#pointerOrCancel(event);
    if (pointer === undefined) return;
    if (this.#options.handles.pointerMove(this.#options.navigation.pageSample(pointer))) {
      event.preventDefault();
      return;
    }
    if (!this.#options.coalesced.dispatch(event)) this.handlePointerCancel(event);
    if (this.#options.getInput().interaction !== undefined) event.preventDefault();
  }

  public handlePointerUp(event: PointerEvent): void {
    const pointer = this.#pointerOrCancel(event);
    if (pointer === undefined) return;
    if (this.#options.handles.pointerMove(this.#options.navigation.pageSample(pointer))) {
      this.#options.handles.pointerUp(event.pointerId);
      this.#releasePointer(event.pointerId);
      this.#options.finishHandlePointer();
      event.preventDefault();
      return;
    }
    if (!this.#options.coalesced.dispatch(event)) {
      this.handlePointerCancel(event);
      return;
    }
    this.#options.dispatch({ type: "pointer-up", pointerId: event.pointerId });
    event.preventDefault();
  }

  public handleLostPointerCapture(event: PointerEvent): void {
    if (!this.#options.isEnabled()) return;
    this.#options.releasePointer(event.pointerId);
    if (this.#options.handles.cancel(event.pointerId)) {
      this.#options.finishHandlePointer();
      return;
    }
    this.#options.dispatch({ type: "lost-pointer-capture", pointerId: event.pointerId });
  }

  #pointerOrCancel(event: PointerEvent): PointerSample | undefined {
    if (!this.#options.isEnabled()) return undefined;
    const pointer = this.#options.navigation.screenPointer(event);
    if (isValidPointerSample(pointer)) {
      this.#options.setLastPointer(this.#options.navigation.pageSample(pointer), pointer);
      return pointer;
    }
    this.handlePointerCancel(event);
    return undefined;
  }

  #releasePointer(pointerId: number): void {
    this.#options.releasePointer(pointerId);
  }
}
