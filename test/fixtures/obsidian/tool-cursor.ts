import { vi } from "vitest";

import { createBuiltInSettings } from "../../../src/domain/settings/defaults";
import { createInputState, type InputState } from "../../../src/editor/input";
import type { ToolSystemCursor } from "../../../src/editor/input/tool-cursor";
import { ActiveToolCursorController } from "../../../src/obsidian/embeds/active-editor/tool-cursor-controller";
import type { SvgSceneRenderer } from "../../../src/rendering/scene";
import type { SceneToolCursorFrame } from "../../../src/rendering/scene/tool-cursor";
import { domRect } from "./active-editor";

export function cursorPointerEvent(overrides: Partial<PointerEvent> = {}): PointerEvent {
  return Object.assign(
    new Event("pointerenter"),
    {
      clientX: 120,
      clientY: 80,
      pointerId: 1,
      pointerType: "mouse",
      pressure: 0,
      button: -1,
      buttons: 0,
      isPrimary: true,
      ctrlKey: false,
      metaKey: false,
    },
    overrides,
  ) as PointerEvent;
}

export function timedCursorPointerEvent(
  timeStamp: number,
  overrides: Partial<PointerEvent> = {},
  type = "pointerenter",
): PointerEvent {
  const fields = Object.fromEntries(Object.entries(cursorPointerEvent(overrides)));
  const event = Object.assign(new Event(type), fields) as PointerEvent;
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  return event;
}

export function toolCursorHarness(
  options: {
    readonly input?: () => InputState;
    readonly scrollBounds?: () => DOMRect;
    readonly activeHandlePointer?: () => number | undefined;
  } = {},
) {
  const surface = new EventTarget();
  const document = Object.assign(new EventTarget(), { hidden: false });
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const window = Object.assign(new EventTarget(), {
    document,
    navigator: { platform: "Linux" },
    getComputedStyle: vi.fn(() => ({})),
    setTimeout: vi.fn((callback: () => void, _delay: number) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    }),
    clearTimeout: vi.fn((timer: number) => timers.delete(timer)),
  });
  const bounds = { left: 20, top: 30, width: 500, height: 400 };
  const measure = vi.fn(() => domRect(bounds));
  const controls = {
    input: createInputState(),
    enabled: true,
    menuOpen: false,
    cameraX: 0,
    handlePointer: undefined as number | undefined,
    hint: undefined as ToolSystemCursor | undefined,
  };
  let reader: ((layoutChanged: boolean) => SceneToolCursorFrame) | undefined;
  const request = vi.fn((next: typeof reader) => {
    reader = next;
  });
  const move = vi.fn();
  const defaults = createBuiltInSettings().toolDefaults;
  const toolIcon = {} as SVGSVGElement;
  const icon = vi.fn(() => toolIcon);
  const handleCursor = vi.fn(() => controls.hint);
  const controller = new ActiveToolCursorController({
    container: {
      ownerDocument: { defaultView: window },
      getBoundingClientRect: measure,
    } as unknown as HTMLElement,
    renderer: {
      inputSurface: surface,
      requestToolCursorFrame: request,
      moveToolCursor: move,
    } as unknown as SvgSceneRenderer,
    input: options.input ?? (() => controls.input),
    defaults: () => defaults,
    icon,
    enabled: () => controls.enabled,
    menuOpen: () => controls.menuOpen,
    cameraX: () => controls.cameraX,
    handleCursor,
    ...(options.scrollBounds === undefined ? {} : { scrollBounds: options.scrollBounds }),
    activeHandlePointer: options.activeHandlePointer ?? (() => controls.handlePointer),
  });
  const read = (changed = false) => {
    if (reader === undefined) throw new Error("No cursor frame requested.");
    return reader(changed);
  };
  return {
    controller,
    controls,
    bounds,
    defaults,
    handleCursor,
    icon,
    toolIcon,
    measure,
    request,
    move,
    read,
    surface,
    window,
    document,
    timers,
    flushTimers: () => {
      for (const [id, callback] of timers) {
        timers.delete(id);
        callback();
      }
    },
  };
}
