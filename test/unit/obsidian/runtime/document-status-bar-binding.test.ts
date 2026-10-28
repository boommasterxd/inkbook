// @vitest-environment happy-dom

import type { Workspace } from "obsidian";
import { MotionGlobalConfig } from "motion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { resolveDocumentStatusPane } from "../../../../src/obsidian/runtime/document-status-bar-binding";
import { createHtmlElement } from "../../../adapters/obsidian/dom";
import { documentStatusBarBindingFixture } from "../../../fixtures/obsidian/document-status-bar-binding";

const cleanups: (() => void)[] = [];
beforeEach(() => {
  MotionGlobalConfig.useManualTiming = true;
});
afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  MotionGlobalConfig.useManualTiming = false;
});

function fixture() {
  const value = documentStatusBarBindingFixture();
  cleanups.push(value.cleanup);
  return value;
}

it("restores the owning pane before host root reinsertion without scheduling frames", () => {
  const value = fixture();
  value.root.remove();
  value.emit();
  expect(value.source.current()).toEqual({ path: "drawing.svg", status: "saved" });
  value.select(createHtmlElement("div"));
  value.emit();
  expect(value.source.current()).toBeNull();
  value.select(value.pane);
  value.emit();
  expect(value.item.firstElementChild?.getAttribute("data-save-status")).toBe("saved");
  expect(value.pane.contains(value.root)).toBe(false);
  value.pane.append(value.root);
  value.ready();
  expect(value.source.current()).toEqual({ path: "drawing.svg", status: "saved" });
  expect(value.requestFrame).not.toHaveBeenCalled();
  expect(value.workScheduler).not.toHaveBeenCalled();
  expect(value.getLeaves).toHaveBeenCalledOnce();
});

it("uses public active Markdown views and layout readiness but no layout-change subscription", () => {
  const value = fixture();
  value.emit("layout-change");
  expect(value.readPane).toHaveBeenCalledOnce();
  value.select(null);
  value.ready();
  expect(value.refresh).toHaveBeenLastCalledWith(null);
  expect(value.source.current()).toBeNull();
  value.select(value.pane);
  value.emit();
  expect(value.readPane).toHaveBeenCalledTimes(3);
  expect(value.source.current()?.status).toBe("saved");
});

it("cleans up once and ignores late layout readiness, events and settings", () => {
  const value = fixture();
  const status = value.item.firstElementChild as HTMLElement;
  value.setMotion("reduced");
  expect(status.dataset.inkbookMotion).toBe("reduced");
  value.dispose();
  value.release();
  value.ready();
  value.emit();
  value.setMotion("full");
  expect(status.dataset.inkbookMotion).toBe("reduced");
  expect(value.item.isConnected).toBe(false);
  expect(value.item.children).toHaveLength(0);
  expect(value.unsubscribeSettings).toHaveBeenCalledOnce();
  expect(value.readPane).toHaveBeenCalledOnce();
  expect(value.refresh).toHaveBeenCalledOnce();
});

it("refreshes stylesheet colors on public css-change without replacing the current status", async () => {
  const value = fixture();
  const status = value.item.firstElementChild as HTMLElement;
  const icon = status.querySelector(".inkbook-status-bar-icon");
  const readStyle = vi.spyOn(window, "getComputedStyle");
  const stylesheet = document.createElementNS("http://www.w3.org/1999/xhtml", "style");
  stylesheet.textContent = ":root { --text-muted: rgb(40, 40, 40); }";
  document.head.append(stylesheet);
  try {
    await new Promise<void>((resolve) => window.queueMicrotask(resolve));
    expect(readStyle).not.toHaveBeenCalled();
    value.emit("css-change");
    expect(
      readStyle.mock.calls.some(
        ([element]) => element.getAttribute("data-inkbook-chrome-color") === "muted",
      ),
    ).toBe(true);
    expect(value.item.firstElementChild).toBe(status);
    expect(status.querySelector(".inkbook-status-bar-icon")).toBe(icon);
    expect(status.dataset.saveStatus).toBe("saved");
    expect(status.textContent).toContain("Saved");
    value.dispose();
    readStyle.mockClear();
    value.emit("css-change");
    expect(readStyle).not.toHaveBeenCalled();
  } finally {
    stylesheet.remove();
  }
});

it("resolves owning public Markdown leaf containers and rejects missing membership", () => {
  const first = createHtmlElement("div");
  const second = createHtmlElement("div");
  const root = createHtmlElement("div");
  second.append(root);
  const leaves = vi.fn(() => [first, second].map((containerEl) => ({ view: { containerEl } })));
  const workspace = { getLeavesOfType: leaves } as unknown as Workspace;
  expect(resolveDocumentStatusPane(workspace, root)).toBe(second);
  expect(leaves).toHaveBeenLastCalledWith("markdown");
  root.remove();
  expect(resolveDocumentStatusPane(workspace, root)).toBeUndefined();
});
