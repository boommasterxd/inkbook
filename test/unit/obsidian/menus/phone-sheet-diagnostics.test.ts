// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHtmlElement, installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

import {
  type PhoneSheetDiagnosticReport,
  installPhoneSheetDiagnostics,
} from "../../../../src/obsidian/menus/phone-sheet-diagnostics";

const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  installObsidianDomHelpers();
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture(platform = "phone", accepted = true) {
  const layer = createHtmlElement("div");
  layer.dataset.platform = platform;
  const surface = createHtmlElement("section");
  surface.className = "inkbook-adaptive-panel";
  surface.dataset.kind = "dialog";
  const input = createHtmlElement("input");
  input.value = "PRIVATE NOTE TEXT";
  input.setAttribute("aria-label", "Private label");
  surface.append(input);
  layer.append(surface);
  document.body.append(layer);
  const callbacks = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callbacks.set(++sequence, callback);
    return sequence;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    callbacks.delete(id);
  });
  const claim = vi.fn(() => accepted);
  const complete = vi.fn<(report: PhoneSheetDiagnosticReport) => void>();
  const cleanup = installPhoneSheetDiagnostics(document, { claim, complete });
  cleanups.push(cleanup);
  return {
    report() {
      const report = complete.mock.calls[0]?.[0];
      if (!report) throw new Error("Missing report");
      return report;
    },
    surface,
    input,
    claim,
    complete,
    cleanup,
    callbacks,
    frame() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach((callback) => callback(performance.now()));
    },
    pointer(type: string, y = 10, pointerId = 1) {
      input.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerType: "touch",
          pointerId,
          clientY: y,
          screenY: y + 50,
        }),
      );
    },
  };
}

function begin(f: ReturnType<typeof fixture>) {
  f.pointer("pointerdown");
  f.surface.dataset.swipeState = "dragging";
  f.pointer("pointermove", 20);
  f.frame();
}

describe("phone sheet swipe diagnostics", () => {
  it("records geometry and coalesced movement without input content, then includes settling frames", () => {
    const f = fixture();
    begin(f);
    f.pointer("pointermove", 20);
    f.pointer("pointermove", 30);
    f.surface.setCssProps({ translate: "0 20px" });
    f.frame();
    f.pointer("pointerup", 30);
    f.surface.dataset.swipeState = "settling";
    f.frame();
    expect(f.complete).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(f.claim).toHaveBeenCalledOnce();
    expect(f.complete).toHaveBeenCalledOnce();
    const report = f.report();
    expect(report.frames[1]?.pointer?.clientY).toBe(30);
    expect(report.frames[1]?.inlineTranslate).toBe("0 20px");
    expect(report.frames[2]?.swipeState).toBe("settling");
    expect(report.reason).toBe("released");
    expect(JSON.stringify(report)).not.toContain("PRIVATE");
    expect(f.callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["desktop", "tablet"])("ignores %s panels", (platform) => {
    const f = fixture(platform);
    begin(f);
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.callbacks.size).toBe(0);
  });

  it("does not consume a report for a tap or rejected budget", () => {
    const f = fixture("phone", false);
    f.pointer("pointerdown");
    f.frame();
    f.pointer("pointerup");
    vi.advanceTimersByTime(300);
    expect(f.claim).not.toHaveBeenCalled();
    begin(f);
    expect(f.claim).toHaveBeenCalledOnce();
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores other pointers and records cancellation only once", () => {
    const f = fixture();
    begin(f);
    f.pointer("pointercancel", 10, 2);
    vi.advanceTimersByTime(300);
    expect(f.complete).not.toHaveBeenCalled();
    f.pointer("lostpointercapture");
    f.pointer("pointercancel");
    f.pointer("pointerup");
    vi.advanceTimersByTime(300);
    expect(f.complete).toHaveBeenCalledOnce();
    expect(f.report().reason).toBe("cancelled");
  });

  it("bounds abandoned gestures and boundary-event storms", () => {
    const f = fixture();
    begin(f);
    for (let i = 0; i < 400; i++) f.pointer("lostpointercapture");
    vi.advanceTimersByTime(60_000);
    expect(f.complete).toHaveBeenCalledOnce();
    expect(f.report().reason).toBe("timeout");
    expect(f.report().events).toHaveLength(256);
    expect(f.callbacks.size).toBe(0);
  });

  it("cancels active work and removes listeners on disposal", () => {
    const f = fixture();
    begin(f);
    f.cleanup();
    f.pointer("pointerdown");
    vi.advanceTimersByTime(60_000);
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("diagnostic sampling limits", () => {
  it("does not claim grabber taps and waits for cumulative slow downward movement", () => {
    const f = fixture();
    f.pointer("pointerdown", 10);
    f.surface.dataset.swipeState = "dragging";
    f.frame();
    f.pointer("pointerup", 10);
    vi.advanceTimersByTime(300);
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
    f.pointer("pointerdown", 10);
    for (let y = 10.25; y < 16; y += 0.25) {
      f.pointer("pointermove", y);
      f.frame();
      vi.advanceTimersByTime(100);
    }
    expect(f.claim).not.toHaveBeenCalled();
    f.pointer("pointermove", 16);
    f.frame();
    expect(f.claim).toHaveBeenCalledOnce();
    f.pointer("pointerup", 16);
    vi.advanceTimersByTime(300);
    expect(f.complete).toHaveBeenCalledOnce();
  });

  it("samples animation metadata at most every 250 ms without keyframe values", () => {
    const f = fixture();
    const getAnimations = vi.fn(() => [
      {
        playState: "running",
        currentTime: 20,
        effect: { getKeyframes: () => [{ translate: "PRIVATE ANIMATION VALUE" }] },
      },
    ]);
    Object.defineProperty(f.surface, "getAnimations", { value: getAnimations });
    begin(f);
    f.frame();
    expect(getAnimations).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(250);
    f.frame();
    expect(getAnimations).toHaveBeenCalledTimes(2);
    f.pointer("pointerup");
    vi.advanceTimersByTime(300);
    const report = f.report();
    expect(report.frames[0]?.animations?.[0]?.properties).toEqual(["translate"]);
    expect(JSON.stringify(report)).not.toContain("PRIVATE");
  });
});

describe("diagnostic operation budgets", () => {
  it("coalesces event storms into one geometry and style read per frame", () => {
    const f = fixture();
    const geometry = vi.spyOn(f.surface, "getBoundingClientRect");
    const computed = vi.spyOn(window, "getComputedStyle");
    begin(f);
    geometry.mockClear();
    computed.mockClear();
    for (let i = 0; i < 1000; i++) f.pointer("pointermove", i);
    expect(geometry).not.toHaveBeenCalled();
    expect(computed).not.toHaveBeenCalled();
    expect(f.callbacks.size).toBe(1);
    f.frame();
    expect(geometry).toHaveBeenCalledOnce();
    expect(computed).toHaveBeenCalledOnce();
    f.pointer("pointerup");
    vi.advanceTimersByTime(300);
    expect(f.report().frames[1]?.pointer?.clientY).toBe(999);
    expect(f.report().frames[1]?.pointer?.target).toBe("descendant");
    expect(f.report().frames[1]?.connected).toBe(true);
  });

  it("bounds high refresh-rate traces and serialized report size", () => {
    const f = fixture();
    begin(f);
    for (let i = 1; i < 7200; i++) {
      f.pointer("pointermove", i);
      f.frame();
    }
    const report = f.report();
    expect(report.reason).toBe("frame-limit");
    expect(report.truncated).toBe(true);
    expect(report.frames.length).toBeLessThanOrEqual(7200);
    expect(JSON.stringify(report).length).toBeLessThanOrEqual(1_900_000);
    expect(f.callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
