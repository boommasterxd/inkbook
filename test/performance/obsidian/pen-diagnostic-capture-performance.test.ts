// @vitest-environment happy-dom

import { expect, it, onTestFinished, vi } from "vitest";

import {
  PenEventCapture,
  PEN_DIAGNOSTIC_MAX_EVENTS,
} from "../../../src/obsidian/diagnostics/pen-event-capture";
import * as records from "../../../src/obsidian/diagnostics/pen-event-record";
import { createHtmlElement } from "../../adapters/obsidian/dom";

function createCapture() {
  const onLimit = vi.fn();
  const capture = new PenEventCapture({ onLimit });
  onTestFinished(() => {
    capture.dispose();
    vi.restoreAllMocks();
  });
  return { capture, onLimit };
}

it("bounds actual serialization and queued records across idle, capacity, drains and restart", () => {
  const { capture, onLimit } = createCapture();
  const serialize = vi.spyOn(records, "recordPenEvent");
  const layout = vi.spyOn(document.body, "getBoundingClientRect");
  capture.addWindow(window);
  const event = new PointerEvent("pointerrawupdate", {
    pointerType: "pen",
    pressure: 0.5,
    buttons: 3,
    clientX: 50,
    clientY: 100,
  });
  window.dispatchEvent(event);
  expect(serialize).not.toHaveBeenCalled();
  expect(capture.drain()).toHaveLength(0);

  capture.start();
  // One environment record consumes capacity before raw input begins.
  for (let index = 0; index < PEN_DIAGNOSTIC_MAX_EVENTS; index += 1) window.dispatchEvent(event);
  const full = capture.drain();
  expect(full).toHaveLength(PEN_DIAGNOSTIC_MAX_EVENTS);
  expect(serialize).toHaveBeenCalledTimes(PEN_DIAGNOSTIC_MAX_EVENTS - 1);
  expect(onLimit).toHaveBeenCalledOnce();
  expect(capture.eventCount).toBe(PEN_DIAGNOSTIC_MAX_EVENTS);
  expect(layout).not.toHaveBeenCalled();
  window.dispatchEvent(event);
  expect(serialize).toHaveBeenCalledTimes(PEN_DIAGNOSTIC_MAX_EVENTS - 1);
  expect(capture.drain()).toHaveLength(0);

  capture.start();
  window.dispatchEvent(event);
  capture.stop();
  window.dispatchEvent(event);
  expect(serialize).toHaveBeenCalledTimes(PEN_DIAGNOSTIC_MAX_EVENTS);
  expect(capture.drain()).toHaveLength(2);
  capture.dispose();
  window.dispatchEvent(event);
  expect(serialize).toHaveBeenCalledTimes(PEN_DIAGNOSTIC_MAX_EVENTS);
});

it("bounds registered native listeners to eight windows and releases each registration once", () => {
  const { capture } = createCapture();
  const owners = Array.from({ length: 9 }, () => {
    const frame = createHtmlElement("iframe");
    document.body.append(frame);
    onTestFinished(() => frame.remove());
    const owner = frame.contentWindow!;
    return {
      owner,
      add: vi.spyOn(owner, "addEventListener"),
      remove: vi.spyOn(owner, "removeEventListener"),
      documentAdd: vi.spyOn(owner.document, "addEventListener"),
      documentRemove: vi.spyOn(owner.document, "removeEventListener"),
    };
  });
  const cleanups = owners.map(({ owner }) => capture.addWindow(owner));
  for (const item of owners.slice(0, 8)) {
    expect(item.add).toHaveBeenCalledTimes(23);
    expect(item.documentAdd).toHaveBeenCalledTimes(1);
    expect(
      item.add.mock.calls.every((call) => {
        const options = call[2] as AddEventListenerOptions;
        return options.capture === true && options.passive === true;
      }),
    ).toBe(true);
  }
  expect(owners[8]!.add).not.toHaveBeenCalled();
  expect(owners[8]!.documentAdd).not.toHaveBeenCalled();
  capture.dispose();
  for (const cleanup of cleanups) cleanup();
  for (const item of owners.slice(0, 8)) {
    expect(item.remove).toHaveBeenCalledTimes(23);
    expect(item.documentRemove).toHaveBeenCalledTimes(1);
    for (const [type, listener] of item.add.mock.calls) {
      expect(item.remove).toHaveBeenCalledWith(type, listener, true);
    }
  }
});
