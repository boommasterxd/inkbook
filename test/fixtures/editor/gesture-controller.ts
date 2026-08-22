import { vi, type Mock } from "vitest";

import {
  GestureController,
  type GestureControllerPorts,
} from "../../../src/editor/gestures/public";
import type { PointerSample } from "../../../src/editor/input/input-types";

export interface GestureControllerHarness {
  readonly controller: GestureController;
  readonly preview: GesturePreviewSpies;
  readonly releasePointer: Mock<(this: void, pointerId: number) => void>;
}

interface GesturePreviewSpies {
  readonly update: Mock<(this: void, pointer: PointerSample) => void>;
  readonly commit: Mock<(this: void) => boolean>;
  readonly revert: Mock<(this: void) => void>;
}

export function createGestureControllerHarness(): GestureControllerHarness {
  const preview: GesturePreviewSpies = {
    update: vi.fn<(this: void, pointer: PointerSample) => void>(),
    commit: vi.fn<(this: void) => boolean>(() => true),
    revert: vi.fn<(this: void) => void>(),
  };
  const releasePointer = vi.fn();
  const ports: GestureControllerPorts = {
    beginPreview: () => preview,
    capturePointer: vi.fn(),
    releasePointer,
    scheduleLongPress: vi.fn(),
    cancelLongPress: vi.fn(),
    activateTemporaryEraser: vi.fn(),
    restoreTemporaryTool: vi.fn(),
    selectElement: vi.fn(),
    clearSelection: vi.fn(),
    scrollNote: vi.fn(),
    panPage: vi.fn(),
    revertNavigation: vi.fn(),
    beginPinch: vi.fn(),
    updatePinch: vi.fn(),
    finishPinch: vi.fn(),
    revertPinch: vi.fn(),
    openContextMenu: vi.fn(),
  };
  return { controller: new GestureController(ports), preview, releasePointer };
}
