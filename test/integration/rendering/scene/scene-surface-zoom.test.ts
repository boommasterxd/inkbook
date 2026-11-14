// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";

import { sceneSurfaceZoomFixture } from "../../../fixtures/rendering/scene-surface-zoom";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function flushForeignStyle(h: ReturnType<typeof sceneSurfaceZoomFixture>): void {
  h.deliver();
  expect(h.read).not.toHaveBeenCalled();
  expect(h.scheduler.pendingCount).toBe(1);
  h.scheduler.runAll();
  expect(h.read).toHaveBeenCalledOnce();
}

it("relays live syntax and selection tokens from the host body through one coalesced scene read", () => {
  const h = sceneSurfaceZoomFixture();
  const before = document.body.getAttribute("style");
  const tokens = {
    "--code-normal": "#111111",
    "--code-function": "#e0ac00",
    "--code-punctuation": "#333333",
    "--code-keyword": "#444444",
    "--code-string": "#555555",
    "--code-comment": "#666666",
    "--code-tag": "#e93147",
    "--code-property": "#00bfbc",
    "--code-value": "#7852ee",
    "--text-selection": "#777777",
    "--text-faint": "#888888",
    "--text-accent": "#8a5cf5",
  };
  try {
    for (const [property, value] of Object.entries(tokens))
      h.foreignStyle(document.body, property, value);
    flushForeignStyle(h);
    const body = h.renderer.textDocument.body;
    for (const [property, value] of Object.entries(tokens))
      expect(body.style.getPropertyValue(property)).toBe(value);
    expect(h.drawingWrites).toHaveBeenCalledTimes(12);
    h.read.mockClear();
    h.drawingWrites.mockClear();
    h.foreignStyle(document.body, "--code-function", "#ab3400");
    h.deliver();
    h.foreignStyle(document.body, "--code-comment", "#7c7c7c");
    h.deliver();
    expect(h.read).not.toHaveBeenCalled();
    h.scheduler.runAll();
    expect(h.read).toHaveBeenCalledOnce();
    expect(body.style.getPropertyValue("--code-function")).toBe("#ab3400");
    expect(body.style.getPropertyValue("--code-comment")).toBe("#7c7c7c");
    expect(h.drawingWrites).toHaveBeenCalledTimes(2);
  } finally {
    if (before === null) document.body.removeAttribute("style");
    else document.body.setAttribute("style", before);
    h.release();
  }
});

it("proves multiple owned heights without reads while preserving independent resize writes", () => {
  const h = sceneSurfaceZoomFixture();
  try {
    for (const target of [h.container, h.root, document.body, document.documentElement])
      expect(h.observed.get(target)).toEqual({
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ["class", "style"],
      });
    h.zoom(200.25);
    h.zoom(300.75);
    h.zoom(300.75);
    h.deliver();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.scheduler.pendingCount).toBe(0);
    expect(h.writes).toHaveBeenCalledTimes(2);
    h.resize(300.75);
    expect(h.scheduler.pendingCount).toBe(1);
    h.scheduler.runAll();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.drawingWrites).toHaveBeenCalledExactlyOnceWith("height", "300.75px");
    expect(h.renderer.svg.ownerDocument.body.style.height).toBe("300.75px");
  } finally {
    h.release();
  }
});

it.each(["before", "between", "after"])(
  "refreshes mixed foreign writes %s own heights",
  (phase) => {
    const h = sceneSurfaceZoomFixture();
    try {
      if (phase === "before") h.foreignStyle(h.container, "--text-normal", "red");
      h.zoom(200);
      if (phase === "between") h.foreignStyle(h.container, "--text-normal", "red");
      h.zoom(300);
      if (phase === "after") h.foreignStyle(h.container, "--text-normal", "red");
      flushForeignStyle(h);
      expect(h.drawingWrites).toHaveBeenCalledExactlyOnceWith("--text-normal", "red");
      h.read.mockClear();
      h.zoom(400);
      h.deliver();
      expect(h.scheduler.pendingCount).toBe(0);
      expect(h.read).not.toHaveBeenCalled();
    } finally {
      h.release();
    }
  },
);

it("refreshes all foreign observed styles/classes and unknown or explicit theme changes", () => {
  const h = sceneSurfaceZoomFixture();
  try {
    for (const target of [h.container, h.root, document.body, document.documentElement]) {
      for (const change of [
        () => h.foreignStyle(target, "--text-normal", "blue"),
        () => h.foreignClass(target),
      ]) {
        h.read.mockClear();
        h.zoom(Number.parseFloat(h.container.style.blockSize || "0") + 1);
        change();
        h.deliver();
        h.scheduler.runAll();
        expect(h.read).toHaveBeenCalledOnce();
      }
    }
    for (const refresh of [h.unknown, () => h.renderer.setScheme("light")]) {
      h.read.mockClear();
      refresh();
      h.scheduler.runAll();
      expect(h.read).toHaveBeenCalledOnce();
    }
  } finally {
    document.body.style.removeProperty("--text-normal");
    document.documentElement.style.removeProperty("--text-normal");
    document.body.classList.remove("foreign");
    document.documentElement.classList.remove("foreign");
    h.release();
  }
});

it("does not write invalid heights or retain work after release", () => {
  const h = sceneSurfaceZoomFixture();
  for (const height of [NaN, Infinity, -1]) h.zoom(height);
  expect(h.writes).not.toHaveBeenCalled();
  h.zoom(0);
  h.zoom(200);
  h.release();
  h.release();
  h.zoom(300);
  h.deliver();
  h.resize(300);
  h.unknown();
  h.scheduler.runAll();
  expect(h.writes).toHaveBeenCalledTimes(2);
  expect(h.read).not.toHaveBeenCalled();
  expect(h.scheduler.pendingCount).toBe(0);
  expect(h.disconnectTheme).toHaveBeenCalledOnce();
  expect(h.disconnectResize).toHaveBeenCalledOnce();
});

it("keeps resize and explicit refresh behavior when MutationObserver is unavailable", () => {
  const h = sceneSurfaceZoomFixture(false);
  try {
    h.zoom(250.5);
    h.resize(250.5);
    h.scheduler.runAll();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.writes).toHaveBeenCalledOnce();
    expect(h.drawingWrites).toHaveBeenCalledExactlyOnceWith("height", "250.5px");
    h.renderer.setScheme("light");
    h.scheduler.runAll();
    expect(h.read).toHaveBeenCalledOnce();
    expect(h.observed.size).toBe(0);
  } finally {
    h.release();
  }
});
