import type { DocumentSaveStatus } from "../../editor/session/session-port";

export type ToolId =
  "select" | "eraser" | "draw" | "highlighter" | "straight-highlighter" | "shape";

export type ShapeId =
  | "line"
  | "arrow"
  | "rectangle"
  | "ellipse"
  | "triangle"
  | "octagon"
  | "parallelogram"
  | "diamond"
  | "coordinate-system"
  | "table";

export type ToolbarAction =
  | "finger-drawing"
  | "background"
  | "undo"
  | "redo"
  | ToolId
  | "shape-picker"
  | "style"
  | "copy"
  | "cut"
  | "delete"
  | "paste"
  | "lock"
  | "overflow";

type ConfirmableToolbarAction = Extract<ToolbarAction, "copy" | "cut" | "paste">;

export interface ToolbarActionConfirmation {
  readonly action: ConfirmableToolbarAction;
  readonly sequence: number;
}

export const TOOLBAR_ACTION_CONFIRMATION_MS = 900;

export type FlyoutId = "background" | "overflow" | "shape" | "style";

export interface ToolbarState {
  readonly saveStatus?: DocumentSaveStatus;
  readonly activeTool: ToolId;
  readonly actionConfirmation?: ToolbarActionConfirmation | null;
  readonly canPaste: boolean;
  readonly canRedo: boolean;
  readonly canUndo: boolean;
  readonly fingerDrawingAvailable: boolean;
  readonly fingerDrawingEnabled: boolean;
  readonly hasSelection: boolean;
  readonly openFlyout: FlyoutId | null;
  readonly pasteVisible: boolean;
}

export interface ToolbarButtonDefinition {
  readonly action: ToolbarAction;
  readonly icon: string;
  readonly label: string;
}
