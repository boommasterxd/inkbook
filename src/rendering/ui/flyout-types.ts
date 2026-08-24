import type { FlyoutId } from "./toolbar-types";

export type BackgroundType = "none" | "lines" | "dots" | "squares";
export type BackgroundSpacing = "s" | "m" | "l" | "xl";

export interface BackgroundFlyoutState {
  readonly spacing: BackgroundSpacing | null;
  readonly type: BackgroundType;
}

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

export interface StyleChoiceOption {
  readonly label: string;
  readonly value: string;
}

interface StyleChoiceControl {
  readonly id: string;
  readonly kind: "choice";
  readonly label: string;
  readonly mixed?: boolean;
  readonly options: readonly StyleChoiceOption[];
  readonly value: string | null;
}

interface StyleToggleControl {
  readonly checked: boolean;
  readonly id: string;
  readonly kind: "toggle";
  readonly label: string;
}

interface StyleNumberControl {
  readonly id: string;
  readonly kind: "number";
  readonly label: string;
  readonly max: number;
  readonly min: number;
  readonly mixed?: boolean;
  readonly step: number;
  readonly value: number | null;
}

export type StyleControl = StyleChoiceControl | StyleNumberControl | StyleToggleControl;

export interface EditorFlyoutCallbacks {
  readonly onBackgroundSpacingChange: (spacing: BackgroundSpacing) => void;
  readonly onBackgroundTypeChange: (type: BackgroundType) => void;
  readonly onFlyoutClose: (flyout: FlyoutId) => void;
  readonly onOverflowAction: (action: OverflowMenuAction) => void;
  readonly onShapeChange: (shape: ShapeId) => void;
  readonly onStyleChange: (controlId: string, value: boolean | number | string) => void;
}

export type OverflowMenuAction =
  | "bring-forward"
  | "bring-to-front"
  | "copy-embed"
  | "delete-embed"
  | "erase-all"
  | "send-backward"
  | "send-to-back";

export interface OverflowMenuState {
  readonly arrange: Readonly<
    Record<"bring-forward" | "bring-to-front" | "send-backward" | "send-to-back", boolean>
  >;
  readonly canEraseAll: boolean;
  readonly hasSelection: boolean;
}
