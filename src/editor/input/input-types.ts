import type { StartupToolV1 } from "../../domain/settings/types";

export const LONG_PRESS_DELAY_MS = 500;
export const ELEMENT_DRAG_THRESHOLD_PX = 6;
export const EMPTY_TOUCH_THRESHOLD_PX = 10;
export const TOUCH_AXIS_LOCK_THRESHOLD_PX = 4;
export const TOUCH_TAP_MAX_DURATION_MS = 350;
export const TOUCH_TAP_MAX_MOVEMENT_PX = 6;

export type EditorTool = StartupToolV1;

export type InputPhase =
  | "idle"
  | "touch-pending"
  | "note-scroll"
  | "page-pan"
  | "element-move"
  | "lasso"
  | "eraser-gesture"
  | "tool-gesture"
  | "pinch";

export interface InputPoint {
  readonly x: number;
  readonly y: number;
}

export interface PointerSample extends InputPoint {
  readonly pointerId: number;
  readonly pointerType: "mouse" | "pen" | "touch";
  readonly pressure?: number;
}

interface PointerTarget {
  readonly elementId: string;
  readonly isSelected: boolean;
}

export interface PointerDownAction extends PointerSample {
  readonly type: "pointer-down";
  readonly button: number;
  readonly buttons: number;
  readonly controlOrMeta: boolean;
  readonly shift: boolean;
  readonly isPlatformContextClick: boolean;
  readonly penRole?: "normal" | "eraser" | "side-button";
  readonly target?: PointerTarget;
  readonly timestamp?: number;
}

export interface PointerMoveAction extends PointerSample {
  readonly type: "pointer-move";
}

export interface PointerExitAction {
  readonly type: "pointer-up" | "pointer-cancel" | "lost-pointer-capture";
  readonly pointerId: number;
  readonly timestamp?: number;
}

export interface LongPressAction {
  readonly type: "long-press";
  readonly pointerId: number;
}

export interface ContextMenuAction extends InputPoint {
  readonly type: "context-menu";
  readonly source: "keyboard" | "pointer";
  readonly target?: PointerTarget;
}

export interface ConfigureInputAction {
  readonly type: "configure";
  readonly activeTool?: EditorTool;
  readonly deviceFingerDrawingEnabled?: boolean;
  readonly toolbarFingerDrawingEnabled?: boolean;
  readonly hasSelection?: boolean;
  readonly zoom?: number;
  readonly fitZoom?: number;
}

export type InputAction =
  | PointerDownAction
  | PointerMoveAction
  | PointerExitAction
  | LongPressAction
  | ContextMenuAction
  | ConfigureInputAction
  | { readonly type: "reset" };

interface SinglePointerInteraction {
  readonly pointerId: number;
  readonly pointerType: PointerSample["pointerType"];
  readonly penRole: "normal" | "eraser" | "side-button";
  readonly start: InputPoint;
  readonly startedAt?: number;
  readonly current: InputPoint;
  readonly previewStarted: boolean;
  readonly longPressScheduled: boolean;
  readonly temporaryEraser: boolean;
  readonly previousTool: EditorTool;
  readonly tool: EditorTool;
  readonly shift: boolean;
}

export interface TouchPendingInteraction extends SinglePointerInteraction {
  readonly phase: "touch-pending";
  readonly target?: PointerTarget;
}

interface NoteScrollInteraction extends SinglePointerInteraction {
  readonly phase: "note-scroll";
}

interface PagePanInteraction extends SinglePointerInteraction {
  readonly phase: "page-pan";
}

interface ElementMoveInteraction extends SinglePointerInteraction {
  readonly phase: "element-move";
  readonly elementId: string;
}

interface LassoInteraction extends SinglePointerInteraction {
  readonly phase: "lasso";
}

interface EraserInteraction extends SinglePointerInteraction {
  readonly phase: "eraser-gesture";
}

interface ToolInteraction extends SinglePointerInteraction {
  readonly phase: "tool-gesture";
}

export interface PinchInteraction {
  readonly phase: "pinch";
  readonly pointers: readonly [PointerSample, PointerSample];
}

export type InputInteraction =
  | TouchPendingInteraction
  | NoteScrollInteraction
  | PagePanInteraction
  | ElementMoveInteraction
  | LassoInteraction
  | EraserInteraction
  | ToolInteraction
  | PinchInteraction;

export interface InputState {
  readonly activeTool: EditorTool;
  readonly deviceFingerDrawingEnabled: boolean;
  readonly toolbarFingerDrawingEnabled: boolean;
  readonly hasSelection: boolean;
  readonly zoom: number;
  readonly fitZoom: number;
  readonly interaction: InputInteraction | undefined;
  readonly consumedPointerIds: readonly number[];
}

export type PreviewKind = "element-move" | "lasso" | "eraser-gesture" | "tool-gesture";

export type InputEffect =
  | { readonly type: "capture-pointer"; readonly pointerId: number }
  | { readonly type: "release-pointer"; readonly pointerId: number }
  | {
      readonly type: "schedule-long-press";
      readonly pointerId: number;
      readonly delayMs: number;
    }
  | { readonly type: "cancel-long-press"; readonly pointerId: number }
  | { readonly type: "activate-temporary-eraser"; readonly previousTool: EditorTool }
  | { readonly type: "restore-temporary-tool"; readonly tool: EditorTool }
  | {
      readonly type: "select-element";
      readonly elementId: string;
      readonly mode: "add" | "preserve-or-replace" | "replace";
    }
  | { readonly type: "clear-selection" }
  | {
      readonly type: "begin-preview";
      readonly kind: PreviewKind;
      readonly tool: EditorTool;
      readonly pointer: PointerSample;
      readonly additive: boolean;
    }
  | {
      readonly type: "update-preview";
      readonly kind: PreviewKind;
      readonly pointer: PointerSample;
    }
  | { readonly type: "commit-preview"; readonly kind: PreviewKind }
  | { readonly type: "revert-preview"; readonly kind: PreviewKind }
  | {
      readonly type: "scroll-note";
      readonly screenDeltaX: number;
      readonly screenDeltaY: number;
    }
  | { readonly type: "pan-page"; readonly screenDeltaX: number }
  | {
      readonly type: "revert-navigation";
      readonly kind: "note-scroll" | "page-pan";
    }
  | {
      readonly type: "begin-pinch";
      readonly anchor: InputPoint;
      readonly pointers: readonly [number, number];
    }
  | {
      readonly type: "update-pinch";
      readonly anchor: InputPoint;
      readonly factor: number;
    }
  | { readonly type: "finish-pinch" }
  | { readonly type: "revert-pinch" }
  | {
      readonly type: "open-context-menu";
      readonly source: "keyboard" | "pointer" | "touch";
      readonly position: InputPoint;
    };

export interface InputReduction {
  readonly state: InputState;
  readonly effects: readonly InputEffect[];
}

export function createInputState(
  overrides: Partial<
    Pick<
      InputState,
      | "activeTool"
      | "deviceFingerDrawingEnabled"
      | "toolbarFingerDrawingEnabled"
      | "hasSelection"
      | "zoom"
      | "fitZoom"
    >
  > = {},
): InputState {
  return {
    activeTool: overrides.activeTool ?? "draw",
    deviceFingerDrawingEnabled: overrides.deviceFingerDrawingEnabled ?? false,
    toolbarFingerDrawingEnabled: overrides.toolbarFingerDrawingEnabled ?? false,
    hasSelection: overrides.hasSelection ?? false,
    zoom: overrides.zoom ?? 1,
    fitZoom: overrides.fitZoom ?? 1,
    interaction: undefined,
    consumedPointerIds: [],
  };
}

export function inputPhase(state: InputState): InputPhase {
  return state.interaction?.phase ?? "idle";
}
