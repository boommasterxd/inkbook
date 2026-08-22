export type ToolId =
  "select" | "eraser" | "draw" | "highlighter" | "straight-highlighter" | "shape";

export type ToolbarAction =
  | "finger-drawing"
  | "background"
  | "undo"
  | "redo"
  | ToolId
  | "style"
  | "copy"
  | "cut"
  | "delete"
  | "paste"
  | "lock"
  | "overflow";

export type FlyoutId = "background" | "shape" | "style";

export interface ToolbarState {
  readonly activeTool: ToolId;
  readonly canPaste: boolean;
  readonly canRedo: boolean;
  readonly canUndo: boolean;
  readonly fingerDrawingAvailable: boolean;
  readonly fingerDrawingEnabled: boolean;
  readonly hasSelection: boolean;
  readonly openFlyout: FlyoutId | null;
}

export interface ToolbarButtonDefinition {
  readonly action: ToolbarAction;
  readonly icon: string;
  readonly label: string;
}
