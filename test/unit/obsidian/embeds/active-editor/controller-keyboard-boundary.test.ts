// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import {
  createBuiltInDeviceSettings,
  createBuiltInSettings,
} from "../../../../../src/domain/settings";
import { ElementStore } from "../../../../../src/domain/store/public";
import { createDragElement } from "../../../../../src/editor/tools/public";
import { ActiveEditorController } from "../../../../../src/obsidian/embeds/active-editor/controller";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import { attachActiveSceneInputListeners } from "../../../../../src/obsidian/embeds/active-scene-input";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../../../src/obsidian/embeds/document-model-port";
import type { MenuItemPort, MenuPort, MenuPosition } from "../../../../../src/obsidian/menus/index";
import type { BrowserScrollElement } from "../../../../../src/obsidian/scrolling/index";
import { INKBOOK_CLIPBOARD_WEB_MIME } from "../../../../../src/persistence/clipboard/public";
import type { SvgSceneRenderer } from "../../../../../src/rendering/scene/index";

describe("active editor keyboard DOM boundary", () => {
  it("consumes hover zoom from the owning document without canvas focus", () => {
    const harness = createHarness();
    const toolbarButton = createDiv();
    toolbarButton.tabIndex = 0;
    document.body.append(toolbarButton);
    harness.input.dispatchEvent(new PointerEvent("pointerenter"));
    toolbarButton.focus();

    const zoom = key(toolbarButton, "+", { ctrlKey: true });
    expect(zoom.defaultPrevented).toBe(true);

    const editable = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "input",
    ) as HTMLInputElement;
    document.body.append(editable);
    editable.focus();
    expect(key(editable, "+", { ctrlKey: true }).defaultPrevented).toBe(false);

    harness.input.dispatchEvent(new PointerEvent("pointerleave"));
    toolbarButton.focus();
    expect(key(toolbarButton, "+", { ctrlKey: true }).defaultPrevented).toBe(false);
    toolbarButton.remove();
    editable.remove();
    harness.dispose();
  });

  it("consumes Shift+F10 and restores canvas focus when the native menu closes", async () => {
    const harness = createHarness();
    focus(harness.input);

    const event = harness.key("F10", { shiftKey: true });

    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(harness.menu.positions).toHaveLength(1));
    expect(harness.menu.positions).toEqual([
      { ownerDocument: document, position: { x: 400, y: 300 } },
    ]);
    harness.menu.close();
    expect(document.activeElement).toBe(harness.input);
    harness.dispose();
  });

  it.each(["disable", "dispose"] as const)(
    "releases a selection-handle pointer capture on %s",
    (cleanup) => {
      const harness = createHarness();
      harness.selectElement();
      harness.controller.handlePointerUp(primaryPointer());
      harness.capture.release.mockClear();
      harness.capture.set.mockClear();

      harness.controller.handlePointerDown(primaryPointer(50, 50));
      expect(harness.capture.set).toHaveBeenCalledWith(7);
      if (cleanup === "disable") harness.controller.setEnabled(false);
      else harness.dispose();

      expect(harness.capture.release).toHaveBeenCalledOnce();
      expect(harness.capture.release).toHaveBeenCalledWith(7);
      if (cleanup === "disable") harness.dispose();
    },
  );

  it("consumes Escape only while it closes the highest-priority active state", () => {
    const harness = createHarness();
    const trigger = createButton();
    document.body.append(trigger);
    harness.controller.handleToolbarAction("overflow", trigger);
    expect(harness.controller.chromeProps().toolbarState.openFlyout).toBe("overflow");

    expect(harness.key("Escape").defaultPrevented).toBe(true);
    expect(harness.controller.chromeProps().toolbarState.openFlyout).toBeNull();
    expect(harness.key("Escape").defaultPrevented).toBe(false);
    harness.dispose();
  });

  it("preserves native Clipboard and Delete behavior when no canvas action is available", () => {
    const harness = createHarness();

    expect(harness.key("c", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(harness.key("x", { metaKey: true }).defaultPrevented).toBe(false);
    expect(harness.key("v", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(harness.key("Delete").defaultPrevented).toBe(false);
    expect(harness.paste(["text/html"], () => "<p>native</p>").defaultPrevented).toBe(false);
    expect(
      harness.paste([INKBOOK_CLIPBOARD_WEB_MIME], () => '{"format":"inkbook-elements"}')
        .defaultPrevented,
    ).toBe(false);
    harness.controller.handlePointerBoundary(true);
    expect(
      harness.paste([INKBOOK_CLIPBOARD_WEB_MIME], () => '{"format":"inkbook-elements"}')
        .defaultPrevented,
    ).toBe(true);
    harness.dispose();
  });
});

describe("active editor chrome callback boundary", () => {
  it("retains callback identities across semantic state snapshots", () => {
    const harness = createHarness();
    const first = harness.controller.chromeProps();
    const second = harness.controller.chromeProps();

    expect(second.onToolbarAction).toBe(first.onToolbarAction);
    harness.dispose();
  });
});

describe("active editor native paste DOM boundary", () => {
  it("does not consume a native Inkbook paste while editable text owns focus", () => {
    const harness = createHarness();
    const editable = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "textarea",
    ) as HTMLTextAreaElement;
    document.body.append(editable);
    harness.controller.handlePointerBoundary(true);
    editable.focus();

    expect(
      harness.paste([INKBOOK_CLIPBOARD_WEB_MIME], () => '{"format":"inkbook-elements"}')
        .defaultPrevented,
    ).toBe(false);

    editable.remove();
    harness.dispose();
  });

  it("consumes Delete when a canvas selection is active", () => {
    const harness = createHarness();
    harness.selectElement();
    expect(harness.controller.chromeProps().toolbarState.hasSelection).toBe(true);

    expect(harness.key("Delete").defaultPrevented).toBe(true);
    harness.dispose();
  });

  it("claims Canvas Clipboard shortcuts only between pointer enter and leave", () => {
    const harness = createHarness();
    harness.selectElement();

    expect(harness.key("c", { ctrlKey: true }).defaultPrevented).toBe(false);
    harness.controller.handlePointerBoundary(true);
    expect(harness.key("c", { ctrlKey: true }).defaultPrevented).toBe(true);
    harness.controller.handlePointerBoundary(false);
    expect(harness.key("c", { ctrlKey: true }).defaultPrevented).toBe(false);
    harness.dispose();
  });

  it("opens the native overflow menu below its toolbar trigger", () => {
    const harness = createHarness();
    const trigger = createButton();
    document.body.append(trigger);
    trigger.getBoundingClientRect = () =>
      ({ bottom: 144, height: 44, left: 320, right: 364, top: 100, width: 44 }) as DOMRect;

    harness.controller.handleToolbarAction("overflow", trigger);
    expect(harness.controller.chromeProps().toolbarState.openFlyout).toBe("overflow");
    expect(harness.menu.positions).toEqual([
      {
        ownerDocument: document,
        position: { overlap: true, width: 199, x: 242.5, y: 150 },
      },
    ]);
    harness.menu.close();
    expect(harness.controller.chromeProps().toolbarState.openFlyout).toBeNull();
    expect(document.activeElement).toBe(trigger);

    harness.dispose();
  });

  it("reprojects screen-space selection geometry before each camera flush", () => {
    const harness = createHarness();
    harness.selectElement();
    const { setSelectionOverlayPath: setSelectionPath, flushCameraAndOverlayFrame: flush } =
      harness.renderer;
    const initialPath = setSelectionPath.mock.lastCall?.[0];
    const order: string[] = [];
    setSelectionPath.mockImplementation(() => order.push("selection"));
    flush.mockImplementation(() => order.push("flush"));

    harness.controller.setZoom(2);

    expect(setSelectionPath.mock.lastCall?.[0]).not.toBe(initialPath);
    expect(order).toEqual(["selection", "flush"]);
    harness.dispose();
  });
});

function createHarness() {
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
  const model = documentModel(store);
  const controller = new ActiveEditorController({
    applyZoomLayout: vi.fn(),
    backgroundSpacing: () => ({ dots: 25, lines: 25, squares: 25 }),
    container,
    defaults: createBuiltInSettings().toolDefaults,
    deviceSettings: createBuiltInDeviceSettings(),
    history: new ActiveEditorHistory(model),
    interruptLayoutForInput: vi.fn(),
    menuFactory: { create: () => menu, forEvent: () => menu },
    model,
    onCopyEmbed: vi.fn(),
    onDeleteEmbed: vi.fn(),
    onLock: vi.fn(),
    onFeedback: vi.fn(),
    onPageChanged: vi.fn(),
    onPagePreviewFinish: vi.fn(),
    onPagePreview: vi.fn(),
    onStateChanged: vi.fn(),
    renderIcon: vi.fn(),
    renderer: renderer as unknown as SvgSceneRenderer,
    sceneStore,
    scrollOwner: owner,
    startupTool: "draw",
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
    },
    renderer,
  };
}

function primaryPointer(clientX = 50, clientY = 100): PointerEvent {
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
    defaults: createBuiltInSettings().toolDefaults,
    end: { x: 200, y: 200 },
    identity: { createdAt: 1, id: "00000000-0000-4000-8000-000000000001" },
    start: { x: 50, y: 50 },
    tool: "rectangle",
  });
}

function createDiv(): HTMLDivElement {
  const element = document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
  document.body.append(element);
  return element;
}

function createButton(): HTMLButtonElement {
  return document.createElementNS("http://www.w3.org/1999/xhtml", "button") as HTMLButtonElement;
}

function documentModel(store: ElementStore): EditableDocumentModel {
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
    prepareElementReplacement: vi.fn(async () => ({ status: "cancelled" as const, token: null })),
    removeElements: vi.fn(),
    replaceElements: vi.fn(),
    revision: 0,
    setGestureActive: vi.fn(),
    store,
  };
}

function rendererPort(inputSurface: HTMLDivElement) {
  return {
    clearElementPreviews: vi.fn(),
    clearPreviewTransforms: vi.fn(),
    flushCameraAndOverlayFrame: vi.fn<() => void>(),
    inputSurface,
    interruptMotionForPointerDown: vi.fn(),
    setCamera: vi.fn(),
    setElementPreviews: vi.fn(),
    setLivePath: vi.fn(),
    setOverlayPath: vi.fn(),
    setPreviewTransform: vi.fn(),
    setSelectionOverlayPath: vi.fn<(path: string | null) => void>(),
    setSnapMarkerPath: vi.fn(),
    suppressMotionForNextDelta: vi.fn(),
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

function focus(element: HTMLElement): void {
  element.focus();
}

function key(target: HTMLElement, value: string, options: KeyboardEventInit): KeyboardEvent {
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
