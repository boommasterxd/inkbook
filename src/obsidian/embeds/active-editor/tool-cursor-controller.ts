import { createToolCursorIcon } from "../../icons/tool-cursor-icon";
import type { ToolDefaultsV1 } from "../../../domain/settings/types";
import {
  classifyPointerDown,
  isValidPointerSample,
  type InputState,
  type PointerSample,
} from "../../../editor/input/index";
import { resolveToolCursor, type ToolSystemCursor } from "../../../editor/input/tool-cursor";
import type { SvgSceneRenderer } from "../../../rendering/scene/index";
import type { SceneToolCursorFrame } from "../../../rendering/scene/tool-cursor";
import { measureElementBox, type ElementContentBox } from "./element-content-box";
import { isMacPlatform, normalizePointerType } from "./controller-helpers";

interface CursorPointer {
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerId: number;
  readonly pointerType: PointerSample["pointerType"];
  readonly penRole: "normal" | "eraser" | "side-button";
  readonly controlOrMeta: boolean;
}

export interface ActiveToolCursorOptions {
  readonly container: HTMLElement;
  readonly renderer: SvgSceneRenderer;
  readonly input: () => InputState;
  readonly defaults: () => ToolDefaultsV1;
  readonly enabled: () => boolean;
  readonly menuOpen: () => boolean;
  readonly handleCursor: (pointer: PointerSample) => ToolSystemCursor | undefined;
  readonly cameraX: () => number;
  readonly icon: (
    tool: InputState["activeTool"],
    defaults: ToolDefaultsV1,
  ) => SVGSVGElement | undefined;
  readonly activeHandlePointer?: () => number | undefined;
}

const EMPTY_FRAME: SceneToolCursorFrame = { cursor: null, system: "default" };

/** Owns only the latest device sample; geometry reads happen in the scene read phase. */
export class ActiveToolCursorController {
  readonly #options: ActiveToolCursorOptions;
  readonly #ownerWindow: Window;
  #pointer: CursorPointer | undefined;
  #bounds: ElementContentBox | undefined;
  #disposed = false;
  public lastPagePointer: PointerSample | null = null;
  public lastScreenPointer: PointerSample | null = null;
  public readonly recordSessionPointer = (page: PointerSample, screen: PointerSample): void => {
    this.lastPagePointer = page;
    this.lastScreenPointer = screen;
  };

  public constructor(options: ActiveToolCursorOptions) {
    this.#options = options;
    this.#ownerWindow = options.container.ownerDocument.defaultView!;
    const surface = options.renderer.inputSurface;
    surface.addEventListener("pointerenter", this.#enter);
    surface.addEventListener("pointerleave", this.#leave);
    this.#ownerWindow.addEventListener("blur", this.#blur);
    this.#ownerWindow.document.addEventListener("visibilitychange", this.#visibility);
    this.#ownerWindow.document.addEventListener("keydown", this.#modifier, true);
    this.#ownerWindow.document.addEventListener("keyup", this.#modifier, true);
  }

  public record(event: PointerEvent, phase: "down" | "move" | "up"): void {
    if (this.#disposed || !this.#options.enabled()) return;
    const input = this.#options.input();
    if (!this.#ownsPointer(event.pointerId, input)) return;
    const pointerType = normalizePointerType(event.pointerType);
    if (
      !isValidPointerSample({
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId,
        pointerType,
        pressure: event.pressure,
      })
    ) {
      this.clear();
      return;
    }
    const classification = classifyPointerDown({
      button: event.button,
      buttons: event.buttons,
      controlKey: event.ctrlKey,
      controlOrMeta: event.ctrlKey || event.metaKey,
      isMacPlatform: isMacPlatform(this.#ownerWindow.navigator),
      isPrimary: event.isPrimary,
      pointerType,
    });
    this.#pointer = {
      clientX: event.clientX,
      clientY: event.clientY,
      pointerId: event.pointerId,
      pointerType,
      penRole: classification.penRole,
      controlOrMeta: event.ctrlKey || event.metaKey,
    };
    if (phase === "up" && pointerType === "touch") this.#pointer = undefined;
    this.refresh();
  }

  #ownsPointer(pointerId: number, input: InputState): boolean {
    const owner = this.#options.activeHandlePointer?.();
    if (owner !== undefined && owner !== pointerId) return false;
    const interaction = input.interaction;
    return (
      interaction === undefined ||
      interaction.phase === "pinch" ||
      interaction.pointerId === pointerId
    );
  }

  public refresh(): void {
    if (!this.#disposed) this.#options.renderer.requestToolCursorFrame(this.#read);
  }

  public clear(pointerId?: number): void {
    if (pointerId !== undefined && this.#pointer?.pointerId !== pointerId) return;
    this.#pointer = undefined;
    this.#bounds = undefined;
    this.refresh();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.clear();
    this.#disposed = true;
    const surface = this.#options.renderer.inputSurface;
    surface.removeEventListener("pointerenter", this.#enter);
    surface.removeEventListener("pointerleave", this.#leave);
    this.#ownerWindow.removeEventListener("blur", this.#blur);
    this.#ownerWindow.document.removeEventListener("visibilitychange", this.#visibility);
    this.#ownerWindow.document.removeEventListener("keydown", this.#modifier, true);
    this.#ownerWindow.document.removeEventListener("keyup", this.#modifier, true);
  }

  readonly #enter = (event: PointerEvent): void => this.record(event, "move");
  readonly #leave = (event: PointerEvent): void => this.clear(event.pointerId);
  readonly #blur = (): void => this.clear();
  readonly #visibility = (): void => {
    if (this.#ownerWindow.document.hidden) this.clear();
  };
  readonly #modifier = (event: KeyboardEvent): void => {
    const pointer = this.#pointer;
    if (pointer === undefined || pointer.controlOrMeta === (event.ctrlKey || event.metaKey)) return;
    this.#pointer = { ...pointer, controlOrMeta: event.ctrlKey || event.metaKey };
    this.refresh();
  };

  readonly #read = (layoutChanged: boolean): SceneToolCursorFrame => {
    if (layoutChanged) this.#bounds = undefined;
    const pointer = this.#pointer;
    if (
      this.#disposed ||
      pointer === undefined ||
      !this.#options.enabled() ||
      this.#options.menuOpen()
    )
      return EMPTY_FRAME;
    const state = this.#options.input();
    const bounds = (this.#bounds ??= measureElementBox(this.#options.container).contentBox);
    const screen: PointerSample = {
      pointerId: pointer.pointerId,
      pointerType: pointer.pointerType,
      x: pointer.clientX - bounds.left,
      y: pointer.clientY - bounds.top,
    };
    if (screen.x < 0 || screen.y < 0 || screen.x > bounds.width || screen.y > bounds.height)
      return EMPTY_FRAME;
    const page = {
      ...screen,
      x: screen.x / state.zoom - this.#options.cameraX(),
      y: screen.y / state.zoom,
    };
    if (state.interaction === undefined) this.recordSessionPointer(page, screen);
    const hint = this.#options.handleCursor(page);
    const defaults = this.#options.defaults();
    const resolved = resolveToolCursor({
      state,
      defaults,
      pointer,
      ...(hint === undefined ? {} : { systemHint: hint }),
    });
    const overlay = resolved.overlay;
    if (overlay === undefined) return { system: resolved.system, cursor: null };
    const cursor =
      overlay.kind === "tool"
        ? { ...overlay, x: screen.x, y: screen.y, icon: this.#options.icon(overlay.tool, defaults) }
        : { ...overlay, x: screen.x, y: screen.y };
    return { system: resolved.system, cursor };
  };
}

export function createActiveToolCursorController(
  [container, renderer]: readonly [HTMLElement, SvgSceneRenderer],
  [input, defaults]: readonly [() => InputState, () => ToolDefaultsV1],
  [availability, menus, handles, navigation]: readonly [
    { readonly acceptsInput: boolean },
    { readonly isOpen: boolean },
    {
      readonly activePointerId: number | undefined;
      cursorAt(pointer: PointerSample): ToolSystemCursor | undefined;
    },
    { readonly cameraX: number },
  ],
): ActiveToolCursorController {
  return new ActiveToolCursorController({
    container,
    renderer,
    input,
    defaults,
    enabled: () => availability.acceptsInput,
    menuOpen: () => menus.isOpen,
    handleCursor: (pointer) => handles.cursorAt(pointer),
    activeHandlePointer: () => handles.activePointerId,
    cameraX: () => navigation.cameraX,
    icon: createToolCursorIcon(container.ownerDocument),
  });
}
