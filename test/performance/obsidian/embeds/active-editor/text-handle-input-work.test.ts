// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import type { SelectionHandle } from "../../../../../src/editor/selection/public";
import { ActivePointerCaptureOwner } from "../../../../../src/obsidian/embeds/active-editor/input/pointer-capture";
import { TextHandleInput } from "../../../../../src/obsidian/embeds/active-editor/text-handle-input";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { appendOwnedIframe } from "../../../../fixtures/obsidian/owned-iframe";
import { selectionHandleRefreshFixture } from "../../../../fixtures/obsidian/selection-handle-refresh";
import {
  textHandleHoverFixture,
  textHandleNavigation,
} from "../../../../fixtures/obsidian/text-handle-hover";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { textElement } from "../../../../fixtures/rendering/text";
import { observeSelectionStoreMethod } from "../../../../fixtures/obsidian/selection-store-work";
import * as selectionGeometry from "../../../../../src/editor/selection/public";
import { TextHandleProjection } from "../../../../../src/obsidian/embeds/active-editor/text-handle-projection";
import { TextEditingViewport } from "../../../../../src/rendering/scene/text-editing-viewport";
import { SVG_NAMESPACE } from "../../../../../src/rendering/scene/constants";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function childSurface(captureFailure: boolean) {
  const { frame, document: child } = appendOwnedIframe();
  const target = child.createElement("div");
  child.body.append(target);
  const readFrame = vi
    .spyOn(frame, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(50, 70, 800, 600));
  let captured: number | undefined;
  const setCapture = vi.fn((id: number) => {
    if (captureFailure) throw new DOMException("Pointer ended", "NotFoundError");
    captured = id;
  });
  const releaseCapture = vi.fn(() => {
    captured = undefined;
  });
  Object.assign(child.documentElement, {
    setPointerCapture: setCapture,
    releasePointerCapture: releaseCapture,
    hasPointerCapture: (id: number) => captured === id,
  });
  return {
    child,
    target,
    frame,
    readFrame,
    setCapture,
    releaseCapture,
    endPointer: () => {
      captured = undefined;
    },
  };
}

function fixture(captureFailure = false) {
  const surface = childSurface(captureFailure);
  const { child, target } = surface;
  const hostCapture = vi.fn();
  const captures = new ActivePointerCaptureOwner({
    setPointerCapture: hostCapture,
    hasPointerCapture: () => false,
    releasePointerCapture: vi.fn(),
  });
  let flush!: (ready: boolean) => void;
  const session = {
    active: true,
    focusInput: vi.fn(),
    suspendForGeometry: vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          flush = resolve;
        }),
    ),
    resumeAfterGeometry: vi.fn(async () => true),
  };
  let activeId: number | undefined;
  const handle: SelectionHandle = {
    kind: "scale",
    position: "middle-right",
    point: { x: 150, y: 200 },
  };
  const handles = {
    hitHandle: vi.fn(() => handle),
    get activePointerId() {
      return activeId;
    },
  };
  const pointer = {
    handlePointerDown: vi.fn((event: PointerEvent, _preferred?: SelectionHandle) => {
      activeId = event.pointerId;
      captures.capture(event.pointerId);
    }),
    handlePointerMove: vi.fn<(event: PointerEvent) => void>(),
    handlePointerUp: vi.fn((event: PointerEvent) => {
      activeId = undefined;
      captures.release(event.pointerId);
    }),
    cancelPointer: vi.fn((_id: number) => {
      activeId = undefined;
      input.settled();
    }),
  };
  const input = new TextHandleInput({
    session,
    handles,
    captures,
    pointer: () => pointer,
    ownerWindow: window,
    scheduler: immediateWorkScheduler(),
    navigation: textHandleNavigation,
  });
  const down = (event: PointerEvent) => input.pointerDown(event);
  child.addEventListener("pointerdown", down, true);
  cleanup.push(() => {
    input.dispose();
    child.removeEventListener("pointerdown", down, true);
  });
  const dispatch = (type: string, x = 100, y = 150) => {
    const event = new PointerEvent(type, {
      pointerId: 7,
      pointerType: "mouse",
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      bubbles: true,
      cancelable: true,
    });
    if (type === "pointerup") surface.endPointer();
    target.dispatchEvent(event);
    return event;
  };
  return {
    input,
    session,
    pointer,
    handles,
    dispatch,
    ...surface,
    hostCapture,
    captures,
    flush: (value = true) => flush(value),
  };
}

it("captures the stable child root before flush and replays only the latest move and terminal release", async () => {
  const state = fixture();
  expect(state.dispatch("pointerdown").defaultPrevented).toBe(true);
  expect(state.setCapture).toHaveBeenCalledExactlyOnceWith(7);
  for (let x = 101; x <= 150; x += 1) state.dispatch("pointermove", x);
  state.dispatch("pointerup", 160, 170);
  expect(state.pointer.handlePointerDown).not.toHaveBeenCalled();
  state.flush();
  await vi.waitFor(() => expect(state.pointer.handlePointerUp).toHaveBeenCalledOnce());
  const down = state.pointer.handlePointerDown.mock.calls[0]!;
  expect(down[0].clientX).toBe(150);
  expect(down[0].clientY).toBe(220);
  expect(down[1]).toMatchObject({ kind: "scale", position: "middle-right" });
  expect(state.pointer.handlePointerMove).toHaveBeenCalledOnce();
  expect(state.pointer.handlePointerMove.mock.calls[0]![0].clientX).toBe(210);
  expect(state.setCapture).toHaveBeenCalledOnce();
  expect(state.hostCapture).not.toHaveBeenCalled();
  expect(state.readFrame).toHaveBeenCalledOnce();
  expect(state.session.resumeAfterGeometry).not.toHaveBeenCalled();
  state.input.settled();
  await vi.waitFor(() => expect(state.session.resumeAfterGeometry).toHaveBeenCalledOnce());
  expect(state.captures.owns(7)).toBe(false);
});

it.each(["Escape", "pointercancel", "lostpointercapture"])(
  "cancels %s while source flush is pending without starting geometry",
  async (reason) => {
    const state = fixture();
    state.dispatch("pointerdown");
    if (reason === "Escape")
      state.child.dispatchEvent(
        new KeyboardEvent("keydown", { key: reason, bubbles: true, cancelable: true }),
      );
    else state.dispatch(reason);
    state.flush();
    await vi.waitFor(() => expect(state.session.resumeAfterGeometry).toHaveBeenCalledOnce());
    expect(state.pointer.handlePointerDown).not.toHaveBeenCalled();
    expect(state.releaseCapture).toHaveBeenCalledOnce();
  },
);

it("routes Escape to an active geometry cancel and blocks hidden editor input", async () => {
  const state = fixture();
  state.dispatch("pointerdown");
  state.flush();
  await vi.waitFor(() => expect(state.pointer.handlePointerDown).toHaveBeenCalledOnce());
  const nativeKey = vi.fn();
  state.target.addEventListener("keydown", nativeKey);
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  state.target.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(nativeKey).not.toHaveBeenCalled();
  expect(state.pointer.cancelPointer).toHaveBeenCalledExactlyOnceWith(7);
  expect(state.session.resumeAfterGeometry).toHaveBeenCalledOnce();
});

it("owns gesture keys in both the outer capture and focused input documents, then releases both", async () => {
  const state = fixture();
  const inner = appendOwnedIframe(state.child);
  const content = inner.document.createElement("textarea");
  inner.document.body.append(content);
  Object.assign(state.session, { inputElement: content });
  content.focus();
  const outerAdd = vi.spyOn(state.child, "addEventListener"),
    innerAdd = vi.spyOn(inner.document, "addEventListener");
  const outerRemove = vi.spyOn(state.child, "removeEventListener"),
    innerRemove = vi.spyOn(inner.document, "removeEventListener");
  const nativeKey = vi.fn();
  content.addEventListener("keydown", nativeKey);
  state.dispatch("pointerdown");
  state.flush();
  await vi.waitFor(() => expect(state.pointer.handlePointerDown).toHaveBeenCalledOnce());
  const key = (value: string) => {
    const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
    content.dispatchEvent(event);
    return event;
  };
  expect(key("a").defaultPrevented).toBe(true);
  expect(nativeKey).not.toHaveBeenCalled();
  expect(key("Escape").defaultPrevented).toBe(true);
  expect(state.pointer.cancelPointer).toHaveBeenCalledExactlyOnceWith(7);
  expect(state.pointer.handlePointerUp).not.toHaveBeenCalled();
  expect(state.session.resumeAfterGeometry).toHaveBeenCalledOnce();
  expect(state.setCapture).toHaveBeenCalledOnce();
  for (const add of [outerAdd, innerAdd])
    expect(add.mock.calls.filter(([name]) => name === "keydown")).toHaveLength(1);
  for (const remove of [outerRemove, innerRemove])
    expect(remove.mock.calls.filter(([name]) => name === "keydown")).toHaveLength(1);
  expect(key("a").defaultPrevented).toBe(false);
  expect(nativeKey).toHaveBeenCalledOnce();
  expect(inner.document.activeElement).toBe(content);
  inner.frame.remove();
});

it("handles native NotFound capture without losing input focus or leaking ownership", () => {
  const state = fixture(true);
  expect(state.dispatch("pointerdown").defaultPrevented).toBe(true);
  expect(state.session.suspendForGeometry).not.toHaveBeenCalled();
  expect(state.session.focusInput).toHaveBeenCalledOnce();
  expect(state.captures.owns(7)).toBe(false);
});

it.each(["cm-content", "inkbook-text-table-controls-layer"])(
  "uses visible handle targets for %s without transferring enlarged invisible targets",
  (className) => {
    const state = fixture();
    state.target.className = className;
    state.dispatch("pointerdown");
    expect(state.handles.hitHandle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ x: 150, y: 220 }),
      true,
    );
  },
);

it("releases a pending captured pointer on disposal and ignores its delayed flush completion", async () => {
  const state = fixture();
  state.dispatch("pointerdown");
  state.input.dispose();
  state.flush();
  await state.session.suspendForGeometry.mock.results[0]!.value;
  await Promise.resolve();
  state.dispatch("pointermove");
  expect(state.pointer.handlePointerDown).not.toHaveBeenCalled();
  expect(state.session.resumeAfterGeometry).not.toHaveBeenCalled();
  expect(state.captures.owns(7)).toBe(false);
  expect(state.releaseCapture).toHaveBeenCalledOnce();
});

it("reuses retained source-handle geometry and one frame origin while hovering a 10,000-element document", () => {
  const text = textElement({ id: "00000000-0000-4000-8000-ffffffffffff" });
  const background = Array.from({ length: 9999 }, (_, index) => indexedStroke(index));
  const selection = selectionHandleRefreshFixture([...background, text], [text.id]);
  selection.interaction.renderSelection();
  const read = observeSelectionStoreMethod(selection.sceneStore, "get");
  cleanup.push(read.restore);
  const build = vi.spyOn(selectionGeometry, "selectionOverlayGeometry");
  const state = textHandleHoverFixture(selection.interaction);
  const write = vi.spyOn(state.child.documentElement.style, "setProperty");
  for (let index = 0; index < 100; index += 1)
    state.move({ x: text.x + text.width, y: text.y + text.height / 2 + (index % 2) });
  expect(state.cursor()).toBe("ew-resize");
  expect(read.work.calls).toBe(0);
  expect(build).not.toHaveBeenCalled();
  expect(state.readFrame).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledExactlyOnceWith("--inkbook-text-handle-cursor", "ew-resize");
  state.hover.dispose();
  const reads = state.readFrame.mock.calls.length;
  state.move(text.pivot);
  expect(state.cursor()).toBe("");
  expect(state.readFrame).toHaveBeenCalledTimes(reads);
});

it("projects nested rotated source pointers without native rect or CTM reads per sample", () => {
  const outer = appendOwnedIframe(),
    inner = appendOwnedIframe(outer.document);
  const element = textElement({ x: 10, y: 20, rotation: 30 });
  const group = outer.document.createElementNS(SVG_NAMESPACE, "g");
  const clip = outer.document.createElement("div"),
    container = inner.document.createElement("div");
  inner.document.body.append(container);
  const read = vi.fn(() => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }));
  Object.defineProperty(group, "getScreenCTM", { value: read });
  const viewport = new TextEditingViewport({
    text: { element, group },
    clip,
    container,
    isolatedInput: true,
    bounds: element,
    context: undefined,
    onChanged: undefined,
  });
  viewport.update({ left: 0, top: 0, width: 800, height: 600 }, { x: 0, zoom: 1 });
  const hostRead = vi
    .spyOn(outer.frame, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(50, 70, 800, 600));
  const innerRead = vi.spyOn(inner.frame, "getBoundingClientRect");
  const coordinates = {
    drawingDocument: outer.document,
    toDrawingPoint: (point: { x: number; y: number }) => viewport.toDrawingPoint(point),
    fromDrawingPoint: (point: { x: number; y: number }) => viewport.fromDrawingPoint(point),
    toDrawingRect: (rect: DOMRect) => viewport.toDrawingRect(rect),
  };
  const event = new PointerEvent("pointermove", { clientX: 10, clientY: 20, bubbles: true });
  container.dispatchEvent(event);
  const projection = new TextHandleProjection(event, window, immediateWorkScheduler(), coordinates);
  for (let index = 0; index < 1000; index += 1) {
    const projected = projection.event(event);
    const point = viewport.toDrawingPoint({ x: 10, y: 20 })!;
    expect(projected.clientX).toBe(point.x + 50);
    expect(projected.clientY).toBe(point.y + 70);
  }
  expect(projection.document).toBe(inner.document);
  expect(hostRead).toHaveBeenCalledOnce();
  expect(innerRead).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledOnce();
  const outerEvent = new PointerEvent("pointermove", { clientX: 10, clientY: 20, bubbles: true });
  outer.document.body.dispatchEvent(outerEvent);
  const controls = new TextHandleProjection(
    outerEvent,
    window,
    immediateWorkScheduler(),
    coordinates,
  );
  expect(controls.event(outerEvent).clientX).toBe(60);
  expect(controls.event(outerEvent).clientY).toBe(90);
  controls.dispose();
  projection.dispose();
  viewport.release();
  outer.frame.remove();
});
