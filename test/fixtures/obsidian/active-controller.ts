import { vi } from "vitest";
import * as Settings from "../../../src/domain/settings";
import { ElementStore } from "../../../src/domain/store/public";
import { createDragElement } from "../../../src/editor/tools/public";
import { ActiveEditorController } from "../../../src/obsidian/embeds/active-editor/controller";
import type { ActiveEditorControllerOptions } from "../../../src/obsidian/embeds/active-editor/controller-types";
import { ActiveEditorHistory } from "../../../src/obsidian/embeds/active-editor/history";
import { attachActiveSceneInputListeners } from "../../../src/obsidian/embeds/active-scene/active-scene-input";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../src/obsidian/embeds/document-session/document-model-port";
import type { MenuItemPort, MenuPort, MenuPosition } from "../../../src/obsidian/menus/index";
import type { BrowserScrollElement } from "../../../src/obsidian/scrolling/index";
import type { SvgSceneRenderer } from "../../../src/rendering/scene/index";

import type { SceneToolCursorFrame } from "../../../src/rendering/scene/tool-cursor";
import { workSchedulerFromFrames } from "./work-scheduler";
export function createHarness(
  options: Partial<
    Pick<ActiveEditorControllerOptions, "deviceSettings" | "onDismissOnboarding" | "onFeedback">
  > = {},
) {
  const input = createDiv();
  input.tabIndex = 0;
  const captured = new Set<number>();
  const capture = {
    has: vi.fn((pointerId: number) => captured.has(pointerId)),
    release: vi.fn((pointerId: number) => captured.delete(pointerId)),
    set: vi.fn((pointerId: number) => captured.add(pointerId)),
  };
  input.hasPointerCapture = capture.has;
  input.releasePointerCapture = capture.release;
  input.setPointerCapture = capture.set;
  const container = createDiv();
  const owner = document.body as unknown as BrowserScrollElement;
  defineGeometry(container, owner);
  const store = new ElementStore([selectableElement()]);
  const sceneStore = new ElementSceneStore(store);
  const menu = new RecordedMenu();
  const renderer = rendererPort(input);
  const model = createActiveEditorModel(store);
  const controller = new ActiveEditorController({
    applyZoomLayout: vi.fn(),
    backgroundSpacing: () => ({ dots: 25, lines: 25, squares: 25 }),
    container,
    defaults: Settings.createBuiltInSettings().toolDefaults,
    deviceSettings: Settings.createBuiltInDeviceSettings(),
    history: new ActiveEditorHistory(model),
    interruptLayoutForInput: vi.fn(),
    menuFactory: { create: () => menu, forEvent: () => menu },
    model,
    onCopyEmbed: vi.fn(),
    onDeleteEmbed: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenShortcuts: vi.fn(),
    onLock: vi.fn(),
    onFeedback: vi.fn(),
    onPageChanged: vi.fn(),
    onPagePreviewFinish: vi.fn(),
    onPagePreview: vi.fn(),
    onStateChanged: vi.fn(),
    renderIcon: vi.fn(),
    renderer: renderer as unknown as SvgSceneRenderer,
    workScheduler: workSchedulerFromFrames(window),
    sceneStore,
    selectionMoveLayout: { begin: vi.fn(), finish: vi.fn(), updateBottom: vi.fn() },
    scrollOwner: owner,
    snapping: Settings.createBuiltInSettings().snapping,
    startupTool: "draw",
    ...options,
  });
  const removeInputListeners = attachActiveSceneInputListeners(
    renderer as unknown as SvgSceneRenderer,
    controller,
  );
  const listener = (event: KeyboardEvent): void => controller.handleKeyDown(event);
  input.addEventListener("keydown", listener);
  return {
    capture,
    controller,
    dispose: () => {
      input.removeEventListener("keydown", listener);
      removeInputListeners();
      controller.dispose();
      sceneStore.release();
      input.remove();
      container.remove();
    },
    input,
    key: (value: string, options: KeyboardEventInit = {}) => key(input, value, options),
    menu,
    paste: (types: readonly string[], getData: (mime: string) => string) =>
      paste(input, types, getData),
    selectElement: () => {
      controller.handleToolbarAction("select");
      controller.handlePointerDown(primaryPointer());
      controller.handlePointerUp(primaryPointer());
    },
    renderer,
  };
}

export function primaryPointer(clientX = 50, clientY = 100): PointerEvent {
  const event = new PointerEvent("pointerdown", {
    bubbles: true,
    button: 0,
    buttons: 1,
    clientX,
    clientY,
    pointerId: 7,
    pointerType: "mouse",
  });
  Object.defineProperty(event, "isPrimary", { value: true });
  return event;
}

function selectableElement() {
  return createDragElement({
    defaults: Settings.createBuiltInSettings().toolDefaults,
    end: { x: 200, y: 200 },
    identity: { createdAt: 1, id: "00000000-0000-4000-8000-000000000001" },
    start: { x: 50, y: 50 },
    tool: "rectangle",
  });
}

export function createDiv(): HTMLDivElement {
  const element = document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
  document.body.append(element);
  return element;
}

export function createButton(): HTMLButtonElement {
  return document.createElementNS("http://www.w3.org/1999/xhtml", "button") as HTMLButtonElement;
}

export function createActiveEditorModel(store: ElementStore): EditableDocumentModel {
  return {
    mutationAvailability: "available",
    arrangeElements: vi.fn(),
    commitBandOrder: vi.fn(),
    commitElement: vi.fn(),
    commitElements: vi.fn(),
    commitPage: vi.fn(),
    commitPreparedElementMutation: vi.fn(() => null),
    commitPreparedElementReplacement: vi.fn(() => "noop" as const),
    encodeClipboard: vi.fn(async () => ({
      byteLength: 2,
      compactJson: "{}",
      customText: "INKBOOK/1:{}",
      fingerprint: "fixture",
      payload: { elements: [], format: "inkbook-elements", version: 1 },
      plainText: "INKBOOK/1:{}",
    })),
    page: {
      activeBufferLines: 3,
      background: { type: "none" },
      innerWidth: 2_000,
      lockedBufferLines: 1,
      margin: 24.3,
    },
    planClipboardPaste: vi.fn(async () => null),
    prepareElementMutation: vi.fn(async () => ({ status: "cancelled" as const, token: null })),
    prepareElementAppend: vi.fn(async () => ({ status: "cancelled" as const, token: null })),
    prepareElementArrangement: vi.fn(async () => ({ status: "cancelled" as const, token: null })),
    prepareElementRemoval: vi.fn(async () => ({ status: "cancelled" as const, token: null })),
    prepareElementReplacement: vi.fn(async () => ({ status: "cancelled" as const, token: null })),
    removeElements: vi.fn(),
    replaceElements: vi.fn(),
    revision: 0,
    setGestureActive: vi.fn(),
    store,
  };
}

function rendererPort(inputSurface: HTMLDivElement) {
  let cursorReader: ((layoutChanged: boolean) => SceneToolCursorFrame) | undefined;
  return {
    requestToolCursorFrame: vi.fn((reader: (layoutChanged: boolean) => SceneToolCursorFrame) => {
      cursorReader = reader;
    }),
    flushToolCursorFrame: () => cursorReader?.(false),
    commitLivePath: vi.fn(),
    clearElementFade: vi.fn(),
    clearLiveStroke: vi.fn(),
    commitLiveStroke: vi.fn(),
    clearElementPreviews: vi.fn(),
    clearPreviewTransforms: vi.fn(),
    flushPointerFeedbackFrame: vi.fn<() => void>(),
    inputSurface,
    interruptMotionForPointerDown: vi.fn(),
    setCamera: vi.fn(),
    setMinimumBackgroundBlockSize: vi.fn(),
    sceneCommitProof: 0,
    setViewport: vi.fn<SvgSceneRenderer["setViewport"]>(),
    setElementFade: vi.fn(),
    setElementPreviews: vi.fn(),
    setLivePath: vi.fn(),
    setOverlayPath: vi.fn(),
    setPreviewTransform: vi.fn(),
    setSelectionOverlayPath: vi.fn<(path: string | null) => void>(),
    setSelectedElements: vi.fn<(ids: ReadonlySet<string>) => void>(),
    setSnapMarkerPath: vi.fn(),
    suppressMotionForNextDelta: vi.fn(),
    updateLiveStroke: vi.fn(),
  };
}

function defineGeometry(container: HTMLElement, owner: BrowserScrollElement): void {
  container.getBoundingClientRect = () => rect(0, 0, 800, 600);
  owner.getBoundingClientRect = () => rect(0, 0, 800, 600);
  Object.defineProperties(owner, {
    clientHeight: { configurable: true, value: 600 },
    clientWidth: { configurable: true, value: 800 },
    scrollHeight: { configurable: true, value: 1_200 },
    scrollTop: { configurable: true, value: 0, writable: true },
  });
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

export function key(target: HTMLElement, value: string, options: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: value,
    ...options,
  });
  target.dispatchEvent(event);
  return event;
}

function paste(
  target: HTMLElement,
  types: readonly string[],
  getData: (mime: string) => string,
): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", { value: { getData, types } });
  target.dispatchEvent(event);
  return event;
}

class RecordedMenu implements MenuPort {
  readonly positions: Array<{ readonly ownerDocument: Document; readonly position: MenuPosition }> =
    [];
  #onHide = (): void => undefined;

  addItem(configure: (item: MenuItemPort) => void): MenuPort {
    configure(chainableItem());
    return this;
  }

  addSeparator(): MenuPort {
    return this;
  }

  close(): void {
    this.#onHide();
  }

  onHide(callback: () => void): void {
    this.#onHide = callback;
  }

  showAtPosition(position: MenuPosition, ownerDocument: Document): MenuPort {
    this.positions.push({ ownerDocument, position });
    return this;
  }
}
function chainableItem(): MenuItemPort {
  const item: MenuItemPort = {
    onClick: () => item,
    setDisabled: () => item,
    setIcon: () => item,
    setIsLabel: () => item,
    setTitle: () => item,
    setWarning: () => item,
  };
  return item;
}
