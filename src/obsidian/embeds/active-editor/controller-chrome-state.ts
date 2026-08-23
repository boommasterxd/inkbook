import type {
  ShapeId,
  ToolbarLayoutStage,
  ToolbarState,
  ToolId,
} from "../../../rendering/ui/index";
import type { EditorTool } from "../../../editor/input/index";

export class ActiveEditorChromeState {
  readonly #onStateChanged: () => void;
  #layout: ToolbarLayoutStage = "wide";
  #openFlyout: ToolbarState["openFlyout"] = null;
  #selectedShape: ShapeId = "line";

  public constructor(onStateChanged: () => void) {
    this.#onStateChanged = onStateChanged;
  }

  public get layout(): ToolbarLayoutStage {
    return this.#layout;
  }

  public get openFlyout(): ToolbarState["openFlyout"] {
    return this.#openFlyout;
  }

  public get selectedShape(): ShapeId {
    return this.#selectedShape;
  }

  public activateTool(tool: ToolId, activeTool: EditorTool): EditorTool | undefined {
    if (tool !== "shape") return tool;
    if (activeTool !== this.#selectedShape) return this.#selectedShape;
    this.toggleFlyout("shape");
    return undefined;
  }

  public closeFlyout(): boolean {
    if (this.#openFlyout === null) return false;
    this.setFlyout(null);
    return true;
  }

  public selectShape(shape: ShapeId): ShapeId {
    this.#selectedShape = shape;
    return shape;
  }

  public setFlyout(flyout: ToolbarState["openFlyout"]): void {
    if (this.#openFlyout === flyout) return;
    this.#openFlyout = flyout;
    this.#onStateChanged();
  }

  public setLayout(layout: ToolbarLayoutStage): void {
    if (layout === this.#layout) return;
    this.#layout = layout;
    this.#onStateChanged();
  }

  public toggleFlyout(flyout: NonNullable<ToolbarState["openFlyout"]>): void {
    this.setFlyout(this.#openFlyout === flyout ? null : flyout);
  }
}
