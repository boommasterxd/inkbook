import type { NavigationCursorLayout } from "./navigation-layout";
import { createToolCursorIcon } from "../../icons/tool-cursor-icon";
import type { ToolDefaultsV1 } from "../../../domain/settings/types";
import {
  isValidPointerSample,
  type InputState,
  type PointerSample,
} from "../../../editor/input/index";
import { resolveToolCursor, type ToolSystemCursor } from "../../../editor/input/tool-cursor";
import { PenButtonSession } from "../../../editor/input/pen-button-session";
import type { SvgSceneRenderer } from "../../../rendering/scene/index";
import type { SceneToolCursorFrame } from "../../../rendering/scene/tool-cursor";
import { measureElementBox, type ElementContentBox } from "./element-content-box";
import { normalizePointerType } from "./controller-helpers";

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
  readonly scrollBounds?: () => DOMRect;
}

const EMPTY_FRAME: SceneToolCursorFrame = { cursor: null, system: "default" };

/** Owns only the latest device sample; geometry reads happen in the scene read phase. */
export class ActiveToolCursorController {
  readonly #options: ActiveToolCursorOptions;
  readonly #ownerWindow: Window;
  #pointer: CursorPointer | undefined;
  #bounds: ElementContentBox | undefined;
  #navigationLayout: NavigationCursorLayout | undefined;
  #clip: ElementContentBox | undefined;
  #positionTime = -Infinity;
  #disposed = false;
  readonly #penButtons = new PenButtonSession();
  #penReleaseTimer: { readonly handle: number; readonly deadline: number } | undefined;
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
    surface.addEventListener("pointerrawupdate", this.#rawMove, { passive: true });
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
    const previous = this.#pointer;
    const newerRaw =
      phase === "move" &&
      previous?.pointerId === event.pointerId &&
      previous.pointerType === pointerType &&
      event.timeStamp < this.#positionTime;
    if (!newerRaw) this.#positionTime = event.timeStamp;
    this.#pointer = {
      clientX: newerRaw ? previous.clientX : event.clientX,
      clientY: newerRaw ? previous.clientY : event.clientY,
      pointerId: event.pointerId,
      pointerType,
      penRole: this.#penButtons.update(event, phase),
      controlOrMeta: event.ctrlKey || event.metaKey,
    };
    if (phase === "move") this.#moveDecoration(previous, this.#pointer);
    if (phase === "up" && pointerType === "touch") this.#pointer = undefined;
    this.#schedulePenRelease(event.timeStamp);
    this.refresh();
  }

  public penRole(pointerId: number): CursorPointer["penRole"] {
    return this.#pointer?.pointerId === pointerId ? this.#pointer.penRole : "normal";
  }

  #schedulePenRelease(now: number): void {
    const deadline = this.#penButtons.pendingReleaseAt;
    if (deadline === undefined) {
      this.#cancelPenRelease();
      return;
    }
    if (this.#penReleaseTimer?.deadline === deadline) return;
    this.#cancelPenRelease();
    const handle = this.#ownerWindow.setTimeout(
      () => {
        this.#penReleaseTimer = undefined;
        this.#penButtons.expire(deadline);
        if (this.#pointer?.pointerType === "pen") {
          this.#pointer = { ...this.#pointer, penRole: this.#penButtons.role };
          this.refresh();
        }
      },
      Math.max(0, deadline - now),
    );
    this.#penReleaseTimer = { handle, deadline };
  }

  #cancelPenRelease(): void {
    if (this.#penReleaseTimer === undefined) return;
    this.#ownerWindow.clearTimeout(this.#penReleaseTimer.handle);
    this.#penReleaseTimer = undefined;
  }

  #moveDecoration(previous: CursorPointer | undefined, pointer: CursorPointer): void {
    const bounds = this.#bounds;
    if (
      bounds === undefined ||
      previous?.pointerId !== pointer.pointerId ||
      previous.pointerType !== pointer.pointerType ||
      previous.penRole !== pointer.penRole ||
      previous.controlOrMeta !== pointer.controlOrMeta ||
      this.#options.menuOpen()
    )
      return;
    const x = pointer.clientX - bounds.left;
    const y = pointer.clientY - bounds.top;
    if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) return;
    this.#options.renderer.moveToolCursor(pointer.clientX, pointer.clientY);
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

  public adoptNavigationLayout(layout: NavigationCursorLayout): void {
    this.adoptSceneLayout(layout);
    this.refresh();
  }

  public adoptSceneLayout(layout: NavigationCursorLayout): void {
    if (this.#pointer === undefined) return;
    this.#navigationLayout = layout;
  }

  public refresh(): void {
    if (!this.#disposed) this.#options.renderer.requestToolCursorFrame(this.#read);
  }

  public clear(pointerId?: number): void {
    if (pointerId !== undefined && this.#pointer?.pointerId !== pointerId) return;
    this.#pointer = undefined;
    this.#cancelPenRelease();
    this.#penButtons.reset();
    this.#positionTime = -Infinity;
    this.#bounds = undefined;
    this.#clip = undefined;
    this.#navigationLayout = undefined;
    this.refresh();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.clear();
    this.#disposed = true;
    const surface = this.#options.renderer.inputSurface;
    surface.removeEventListener("pointerenter", this.#enter);
    surface.removeEventListener("pointerleave", this.#leave);
    surface.removeEventListener("pointerrawupdate", this.#rawMove);
    this.#ownerWindow.removeEventListener("blur", this.#blur);
    this.#ownerWindow.document.removeEventListener("visibilitychange", this.#visibility);
    this.#ownerWindow.document.removeEventListener("keydown", this.#modifier, true);
    this.#ownerWindow.document.removeEventListener("keyup", this.#modifier, true);
  }

  readonly #rawMove = (raw: Event): void => {
    const event = raw as PointerEvent;
    const previous = this.#pointer;
    if (
      this.#disposed ||
      !this.#options.enabled() ||
      previous === undefined ||
      event.pointerType === "touch" ||
      event.pointerType !== previous.pointerType ||
      event.pointerId !== previous.pointerId ||
      !this.#ownsPointer(event.pointerId, this.#options.input()) ||
      !Number.isFinite(event.clientX) ||
      !Number.isFinite(event.clientY) ||
      !Number.isFinite(event.timeStamp) ||
      event.timeStamp < this.#positionTime
    )
      return;
    this.#positionTime = event.timeStamp;
    this.#pointer = { ...previous, clientX: event.clientX, clientY: event.clientY };
    this.#moveDecoration(previous, this.#pointer);
  };
  readonly #enter = (event: PointerEvent): void => this.record(event, "move");
  readonly #leave = (event: PointerEvent): void => {
    // Some Wayland Chromium builds report pen proximity-out with the mouse ID.
    // Only clear idle pen feedback for an unpressed departure from the document.
    const penProximityExit =
      this.#pointer?.pointerType === "pen" &&
      event.pointerType === "mouse" &&
      event.buttons === 0 &&
      event.relatedTarget === null &&
      this.#options.input().interaction === undefined &&
      this.#options.activeHandlePointer?.() === undefined;
    this.clear(penProximityExit ? undefined : event.pointerId);
  };
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
    const layout = this.#navigationLayout;
    this.#navigationLayout = undefined;
    if (layout !== undefined) {
      this.#bounds = layout.containerBounds;
      this.#clip = this.#clipBounds(layout.containerBounds, layout.ownerViewport);
    } else if (layoutChanged) {
      this.#bounds = undefined;
      this.#clip = undefined;
    }
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
    const position = {
      x: pointer.clientX,
      y: pointer.clientY,
      clip: (this.#clip ??= this.#clipBounds(bounds)),
    };
    const cursor =
      overlay.kind === "tool"
        ? { ...overlay, ...position, icon: this.#options.icon(overlay.tool, defaults) }
        : { ...overlay, ...position };
    return { system: resolved.system, cursor };
  };
  #clipBounds(
    bounds: ElementContentBox,
    viewport: NavigationCursorLayout["ownerViewport"] | undefined = this.#options.scrollBounds?.(),
  ): ElementContentBox {
    if (viewport === undefined) return bounds;
    const left = Math.max(bounds.left, viewport.left);
    const top = Math.max(bounds.top, viewport.top);
    const right = Math.max(left, Math.min(bounds.right, viewport.right));
    const bottom = Math.max(top, Math.min(bounds.bottom, viewport.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }
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
  scrollBounds: () => DOMRect,
): ActiveToolCursorController {
  return new ActiveToolCursorController({
    container,
    renderer,
    scrollBounds,
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
