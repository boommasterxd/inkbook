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
import type { SelectionFrameSession } from "../../../editor/selection/public";
import { touchInteractionBlocksNativeScroll, touchPanDelta } from "./controller-touch";

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
  readonly selectionFrames?: SelectionFrameSession;
  readonly setLastPointer: (page: PointerSample, screen: PointerSample) => void;
  readonly setSnappingInverted?: (pointerId: number, inverted: boolean | null) => void;
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
      this.#options.selectionFrames,
    );
    this.#options.menus.dispatchFromEvent(event, () =>
      this.#options.dispatch({
        type: "context-menu",
        source: "pointer",
        ...screenPoint,
        ...(target === undefined ? {} : { target }),
      }),
    );
    if (event.cancelable) event.preventDefault();
  }

  public handlePointerCancel(event: PointerEvent): void {
    this.cancelPointer(event.pointerId);
  }

  public cancelPointer(pointerId: number): void {
    this.#options.navigation.cancelPanMomentum();
    this.#setSnappingInverted(pointerId, null);
    if (!this.#options.isEnabled()) {
      this.#releasePointer(pointerId);
      return;
    }
    if (this.#options.handles.cancel(pointerId)) {
      this.#releasePointer(pointerId);
      this.#options.finishHandlePointer();
      return;
    }
    this.#options.dispatch({ type: "pointer-cancel", pointerId });
    this.#releasePointer(pointerId);
  }

  public handlePointerDown(event: PointerEvent): void {
    if (!this.#options.isEnabled()) return;
    this.#setSnappingInverted(event.pointerId, event.altKey === true);
    this.#options.renderer.inputSurface.focus({ preventScroll: true });
    this.#options.navigation.cancelPanMomentum();
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
    if (!this.#options.navigation.beginGestureGeometry()) {
      this.#setSnappingInverted(event.pointerId, null);
      return;
    }
    const pointer = this.#options.navigation.screenPointer(event);
    if (!isValidPointerSample(pointer)) {
      this.#options.navigation.finish();
      this.#setSnappingInverted(event.pointerId, null);
      return;
    }
    const pagePointer = this.#options.navigation.pageSample(pointer);
    this.#options.setLastPointer(pagePointer, pointer);
    if (
      classification.handleEligible &&
      this.#options.handles.pointerDown(pagePointer, event.shiftKey, event.altKey === true)
    ) {
      this.#options.beginHandlePointer(pagePointer.pointerType);
      this.#options.capturePointer(event.pointerId);
      if (event.cancelable) event.preventDefault();
      return;
    }
    const target = selectionTargetAt(
      this.#options.sceneStore,
      this.#options.selection(),
      pagePointer,
      pointer.pointerType,
      this.#options.navigation.zoom,
      this.#options.selectionFrames,
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
          timestamp: event.timeStamp,
          ...(target === undefined ? {} : { target }),
        }),
    );
    if (!interactionOwnsPointer(this.#options.getInput().interaction, event.pointerId)) {
      this.#setSnappingInverted(event.pointerId, null);
    }
    if (event.cancelable && claimsPointerGesture(event, this.#options.getInput().interaction)) {
      event.preventDefault();
    }
  }

  public handlePointerMove(event: PointerEvent): void {
    const pointer = this.#pointerOrCancel(event);
    if (pointer === undefined) return;
    this.#setSnappingInverted(event.pointerId, event.altKey === true);
    const previous = this.#options.getInput().interaction;
    if (
      this.#options.handles.pointerMove(
        this.#options.navigation.pageSample(pointer),
        event.shiftKey,
        event.altKey === true,
      )
    ) {
      if (event.cancelable) event.preventDefault();
      return;
    }
    if (!this.#options.coalesced.dispatch(event)) this.handlePointerCancel(event);
    const interaction = this.#options.getInput().interaction;
    this.#recordTouchPan(event, previous);
    if (event.cancelable && claimsPointerGesture(event, interaction)) event.preventDefault();
    if (event.pointerType === "touch" && interaction?.phase === "page-pan") {
      event.stopPropagation();
    }
  }

  public handlePointerUp(event: PointerEvent): void {
    this.#setSnappingInverted(event.pointerId, event.altKey === true);
    const previous = this.#options.getInput().interaction;
    const pointer = this.#pointerOrCancel(event);
    if (pointer === undefined) return;
    if (
      this.#options.handles.pointerMove(
        this.#options.navigation.pageSample(pointer),
        event.shiftKey,
        event.altKey === true,
      )
    ) {
      this.#options.handles.pointerUp(event.pointerId);
      this.#releasePointer(event.pointerId);
      this.#options.finishHandlePointer();
      this.#setSnappingInverted(event.pointerId, null);
      if (event.cancelable) event.preventDefault();
      return;
    }
    const blocksHostGesture =
      event.pointerType === "touch" && this.#options.getInput().interaction?.phase === "page-pan";
    if (!this.#options.coalesced.dispatch(event)) {
      this.handlePointerCancel(event);
      return;
    }
    this.#recordTouchPan(event, previous);
    this.#options.dispatch({
      type: "pointer-up",
      pointerId: event.pointerId,
      timestamp: event.timeStamp,
    });
    if (blocksHostGesture) this.#options.navigation.releaseTouchPan(event.timeStamp);
    if (event.cancelable && claimsPointerGesture(event, previous)) event.preventDefault();
    if (blocksHostGesture) event.stopPropagation();
    this.#setSnappingInverted(event.pointerId, null);
  }

  public handleLostPointerCapture(event: PointerEvent): void {
    if (!this.#options.isEnabled()) return;
    this.#setSnappingInverted(event.pointerId, null);
    this.#options.navigation.cancelPanMomentum();
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

  #recordTouchPan(event: PointerEvent, previous: InputState["interaction"]): void {
    const current = this.#options.getInput().interaction;
    if (
      event.pointerType !== "touch" ||
      current?.phase !== "page-pan" ||
      previous === undefined ||
      previous.phase === "pinch" ||
      previous.pointerId !== event.pointerId
    ) {
      return;
    }
    this.#options.navigation.recordTouchPan(
      touchPanDelta(current.current.x - previous.current.x),
      event.timeStamp,
    );
  }

  #releasePointer(pointerId: number): void {
    this.#options.releasePointer(pointerId);
  }

  #setSnappingInverted(pointerId: number, inverted: boolean | null): void {
    this.#options.setSnappingInverted?.(pointerId, inverted);
  }
}

function interactionOwnsPointer(
  interaction: InputState["interaction"],
  pointerId: number,
): boolean {
  if (interaction === undefined) return false;
  return interaction.phase === "pinch"
    ? interaction.pointers.some((pointer) => pointer.pointerId === pointerId)
    : interaction.pointerId === pointerId;
}

function claimsPointerGesture(
  event: PointerEvent,
  interaction: InputState["interaction"],
): boolean {
  return (
    interaction !== undefined &&
    (event.pointerType !== "touch" || touchInteractionBlocksNativeScroll(interaction))
  );
}
