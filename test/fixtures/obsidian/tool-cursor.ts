import { vi } from "vitest";

import { createBuiltInSettings } from "../../../src/domain/settings/defaults";
import { createInputState } from "../../../src/editor/input";
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

export function toolCursorHarness() {
  const surface = new EventTarget();
  const document = Object.assign(new EventTarget(), { hidden: false });
  const window = Object.assign(new EventTarget(), {
    document,
    navigator: { platform: "Linux" },
    getComputedStyle: vi.fn(() => ({})),
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
    input: () => controls.input,
    defaults: () => defaults,
    icon,
    enabled: () => controls.enabled,
    menuOpen: () => controls.menuOpen,
    cameraX: () => controls.cameraX,
    handleCursor: () => controls.hint,
    activeHandlePointer: () => controls.handlePointer,
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
    icon,
    toolIcon,
    measure,
    request,
    move,
    read,
    surface,
    window,
    document,
  };
}
