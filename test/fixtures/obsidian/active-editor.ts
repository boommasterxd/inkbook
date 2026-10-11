import { vi } from "vitest";

import type { ElementStore } from "../../../src/domain/store/public";
import type {
  GestureControllerPorts,
  GesturePreviewStart,
} from "../../../src/editor/gestures/public";
import type { CreationPreviewRenderer } from "../../../src/obsidian/embeds/active-editor/creation-preview";
import { ActiveEditorHistory } from "../../../src/obsidian/embeds/active-editor/history";

export function activeEditorStoreHistory(store: ElementStore): ActiveEditorHistory {
  return new ActiveEditorHistory({
    commitBandOrder: (order) => void store.reorderBands(order),
    commitElements: (elements) => void store.create(elements),
    commitPage: vi.fn(),
    removeElements: (ids) => void store.remove(ids),
    replaceElements: (elements, capture) => void store.replaceMany(elements, capture),
  });
}

export function gestureControllerPorts(
  beginPreview: (start: GesturePreviewStart) => ReturnType<GestureControllerPorts["beginPreview"]>,
  overrides: Partial<GestureControllerPorts> = {},
): GestureControllerPorts {
  const pointerLifecycle = {
    cancelLongPress: vi.fn(),
    capturePointer: vi.fn(),
    releasePointer: vi.fn(),
    scheduleLongPress: vi.fn(),
  };
  const navigation = {
    beginPinch: vi.fn(),
    finishPinch: vi.fn(),
    panPage: vi.fn(),
    revertNavigation: vi.fn(),
    revertPinch: vi.fn(),
    scrollNote: vi.fn(),
    updatePinch: vi.fn(),
  };
  return {
    activateTemporaryEraser: vi.fn(),
    beginPreview,
    clearSelection: vi.fn(),
    ...navigation,
    openContextMenu: vi.fn(),
    ...pointerLifecycle,
    restoreTemporaryTool: vi.fn(),
    selectElement: vi.fn(),
    ...overrides,
  };
}

export function creationPreviewRenderer(
  overrides: Partial<CreationPreviewRenderer> = {},
): CreationPreviewRenderer {
  return {
    clearLiveStroke: () => undefined,
    commitLiveStroke: () => undefined,
    commitLivePath: () => undefined,
    setLivePath: () => undefined,
    setSnapMarkerPath: () => undefined,
    suppressMotionForNextDelta: () => undefined,
    updateLiveStroke: () => undefined,
    ...overrides,
  };
}

export interface RectFixture {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

export function domRect(rect: RectFixture): DOMRect {
  return {
    bottom: rect.top + rect.height,
    height: rect.height,
    left: rect.left,
    right: rect.left + rect.width,
    top: rect.top,
    width: rect.width,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  };
}
