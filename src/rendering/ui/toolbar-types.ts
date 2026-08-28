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

export type FlyoutId = "background" | "overflow" | "shape" | "style";

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
