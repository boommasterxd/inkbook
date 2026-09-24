// @vitest-environment happy-dom
import { expect, it, onTestFinished, vi } from "vitest";

import {
  PenEventCapture,
  PEN_DIAGNOSTIC_MAX_EVENTS,
} from "../../../../src/obsidian/diagnostics/pen-event-capture";

import { createHtmlElement } from "../../../adapters/obsidian/dom";

function harness() {
  const onLimit = vi.fn();
  const capture = new PenEventCapture({ onLimit });
  capture.addWindow(window);
  const target = createHtmlElement("div");
  target.classList.add("inkbook-canvas-input");
  document.body.append(target);
  onTestFinished(() => {
    capture.dispose();
    target.remove();
    vi.restoreAllMocks();
  });
  return { capture, target, onLimit };
}

function pointer(type = "pointermove", extra: PointerEventInit = {}) {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 7,
    pointerType: "pen",
    buttons: 3,
    pressure: 0.4,
    clientX: 42,
    clientY: 15,
    ...extra,
  });
}

it("does no event inspection while idle and preserves capture-time state before host consumption", () => {
  const { capture, target } = harness();
  const idle = pointer();
  const path = vi.spyOn(target.classList, "contains");
  target.dispatchEvent(idle);
  expect(path).not.toHaveBeenCalled();
  const consume = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  window.addEventListener("pointermove", consume, true);
  onTestFinished(() => window.removeEventListener("pointermove", consume, true));
  capture.start();
  capture.drain();
  const event = pointer();
  target.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(capture.drain()).toEqual([
    expect.objectContaining({
      pointerType: "pen",
      pointerId: 7,
      buttons: 3,
      pressure: 0.4,
      clientX: 42,
      targetWithinInkbook: true,
      defaultPrevented: false,
    }),
  ]);
  expect(capture.eventCount).toBe(2);
  expect(capture.drain()).toEqual([]);
});

it("records coalesced data and capture ownership with finite, bounded allowlisted samples", () => {
  const { capture, target } = harness();
  target.textContent = "Private note";
  target.id = "private-path";
  const event = pointer("pointerrawupdate");
  Object.defineProperties(event, {
    getCoalescedEvents: {
      value: () => Array.from({ length: 20 }, () => pointer("pointermove", { clientX: NaN })),
    },
    tiltX: { value: Infinity },
  });
  Object.defineProperty(target, "hasPointerCapture", { value: (id: number) => id === 7 });
  capture.start();
  capture.drain();
  target.dispatchEvent(event);
  const [record] = capture.drain();
  expect(record).toMatchObject({ coalescedCount: 20, hasPointerCapture: true });
  expect(record?.["coalescedSamples"]).toHaveLength(4);
  const serialized = JSON.stringify(record);
  expect(serialized).not.toMatch(/private|NaN|Infinity|tiltX/i);
});

it("captures touch metadata, compatibility mouse events, visibility and focus without mutation", () => {
  const { capture, target } = harness();
  capture.start();
  capture.drain();
  const touch = new Event("touchstart", { bubbles: true, cancelable: true });
  const samples = Array.from({ length: 5 }, (_, identifier) => ({
    identifier,
    clientX: identifier,
    force: 0.5,
  }));
  Object.defineProperties(touch, {
    touches: { value: samples },
    targetTouches: { value: samples },
    changedTouches: { value: samples },
  });
  target.dispatchEvent(touch);
  target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2, buttons: 2 }));
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("blur"));
  const records = capture.drain();
  expect(records[0]).toMatchObject({ touchCount: 5, targetTouchCount: 5, changedTouchCount: 5 });
  expect(records[0]?.["changedTouches"]).toHaveLength(2);
  expect(records[1]).toMatchObject({ type: "contextmenu", button: 2 });
  expect(records[2]).toMatchObject({ type: "visibilitychange", hidden: document.hidden });
  expect(records[3]).toMatchObject({ type: "blur", targetWithinInkbook: false });
  expect(touch.defaultPrevented).toBe(false);
});

it("stops exactly at capacity across drains and can reset for a new recording", () => {
  const { capture, target, onLimit } = harness();
  capture.start();
  capture.drain();
  for (let index = 0; index < PEN_DIAGNOSTIC_MAX_EVENTS - 2; index += 1)
    target.dispatchEvent(pointer());
  expect(capture.drain()).toHaveLength(PEN_DIAGNOSTIC_MAX_EVENTS - 2);
  target.dispatchEvent(pointer("pointerup"));
  target.dispatchEvent(pointer());
  expect(capture.drain()).toEqual([expect.objectContaining({ type: "pointerup" })]);
  expect(capture.eventCount).toBe(PEN_DIAGNOSTIC_MAX_EVENTS);
  expect(onLimit).toHaveBeenCalledOnce();
  capture.start();
  capture.drain();
  target.dispatchEvent(pointer("pointerdown"));
  capture.stop();
  target.dispatchEvent(pointer());
  expect(capture.eventCount).toBe(2);
  expect(capture.drain()).toHaveLength(1);
});

it("owns bounded window registrations, idempotent cleanup and a terminal disposal", () => {
  const capture = new PenEventCapture({ onLimit: vi.fn() });
  onTestFinished(() => capture.dispose());
  const windows = Array.from({ length: 9 }, () => {
    const frame = createHtmlElement("iframe");
    document.body.append(frame);
    onTestFinished(() => frame.remove());
    return frame.contentWindow!;
  });
  const removes = windows.map((owner) => capture.addWindow(owner));
  capture.addWindow(windows[0]!)();
  capture.start();
  capture.drain();
  for (const owner of windows) owner.dispatchEvent(new Event("focus"));
  expect(capture.drain()).toHaveLength(8);
  removes[0]!();
  capture.addWindow(windows[0]!);
  capture.drain();
  removes[0]!();
  windows[0]!.dispatchEvent(new Event("focus"));
  expect(capture.drain()).toHaveLength(1);
  capture.dispose();
  capture.start();
  capture.drain();
  capture.addWindow(window)();
  for (const owner of windows) owner.dispatchEvent(new Event("focus"));
  expect(capture.drain()).toEqual([]);
});

it("records bounded environment metadata, refreshed dimensions and retains final records on dispose", () => {
  const { capture, target } = harness();
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("a".repeat(900));
  capture.start();
  const [environment] = capture.drain();
  expect(environment).toMatchObject({
    type: "environment",
    userAgent: "a".repeat(512),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  });
  target.dispatchEvent(pointer("pointermove", { pressure: 0, buttons: 1 }));
  window.dispatchEvent(new Event("resize"));
  capture.dispose();
  expect(capture.drain()).toEqual([
    expect.objectContaining({ type: "pointermove", pressure: 0, buttons: 1 }),
    expect.objectContaining({ type: "resize" }),
    expect.objectContaining({ type: "environment" }),
  ]);
  expect(capture.drain()).toEqual([]);
});
