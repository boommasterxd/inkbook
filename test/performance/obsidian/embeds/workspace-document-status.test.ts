// @vitest-environment happy-dom

import * as obsidian from "obsidian";
import { expect, it, vi } from "vitest";

import { DocumentSaveStatusSource } from "../../../../src/obsidian/embeds/document-save-status";
import { WorkspaceDocumentStatus } from "../../../../src/obsidian/embeds/workspace-document-status";
import { mountDocumentStatusBar } from "../../../../src/obsidian/runtime/document-status-bar";
import { AutosaveCoordinator } from "../../../../src/persistence/saving/autosave/public";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { documentStatusBarBindingFixture } from "../../../fixtures/obsidian/document-status-bar-binding";
import { documentStatusBarMotionFixture } from "../../../fixtures/obsidian/document-status-bar-motion";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import {
  AutosaveDocumentFixture,
  FakeClock,
  MemoryVault,
  serializeSnapshot,
} from "../../../integration/persistence/saving/fixtures";
import { INTERACTION_REFRESH_PROFILE } from "../../interaction-refresh-profile";

function mockNativeStatusIcon() {
  return vi.spyOn(obsidian, "setIcon").mockImplementation((element) => {
    const svg = document.importNode(
      new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"/>',
        "image/svg+xml",
      ).documentElement,
      true,
    );
    element.replaceChildren(svg);
  });
}

function expectNormalizedIcon(icon: Element, viewBox: string) {
  expect(icon.firstElementChild?.getAttribute("viewBox")).toBe(viewBox);
  expect(icon.firstElementChild?.hasAttribute("width")).toBe(false);
  expect(icon.firstElementChild?.hasAttribute("height")).toBe(false);
}

function verifyRetainedStatusNodes(
  workspace: WorkspaceDocumentStatus,
  container: HTMLElement,
  root: HTMLElement,
  observer: MutationObserver,
) {
  const icon = root.querySelector(".inkbook-status-bar-icon")!;
  const glyph = icon.firstElementChild;
  const label = root.querySelector(".inkbook-status-bar-label")!;
  for (let index = 0; index < 10_000; index += 1) workspace.setActivePane(container);
  expect(observer.takeRecords()).toHaveLength(0);
  expect(icon.firstElementChild).toBe(glyph);
  expect(root.querySelector(".inkbook-status-bar-label")).toBe(label);
  return glyph;
}

it(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz: caches public pane ownership across 10,000 host events without frame or DOM work`, () => {
  const value = documentStatusBarBindingFixture();
  const observer = new MutationObserver(() => undefined);
  observer.observe(value.item, { attributes: true, childList: true, subtree: true });
  const changes = vi.fn();
  const unsubscribe = value.source.subscribe(changes);
  try {
    value.root.remove();
    for (let index = 0; index < 10_000; index += 1) {
      value.emit();
    }
    expect(value.readPane).toHaveBeenCalledTimes(10_001);
    expect(value.getLeaves).toHaveBeenCalledOnce();
    expect(value.containment).toHaveBeenCalledOnce();
    expect(value.requestFrame).not.toHaveBeenCalled();
    expect(value.workScheduler).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
    expect(observer.takeRecords()).toHaveLength(0);
    value.select(null);
    value.emit();
    expect(changes).toHaveBeenCalledOnce();
    expect(observer.takeRecords().length).toBeLessThanOrEqual(6);
    value.select(value.pane);
    value.emit();
    expect(changes).toHaveBeenCalledTimes(2);
    expect(observer.takeRecords().length).toBeLessThanOrEqual(6);
    expect(value.source.current()).toEqual({ path: "drawing.svg", status: "saved" });
    value.pane.append(value.root);
    value.dispose();
    value.dispose();
    value.ready();
    value.emit();
    expect(value.frames.pendingCount).toBe(0);
    expect(value.readPane).toHaveBeenCalledTimes(10_003);
    expect(value.containment).toHaveBeenCalledOnce();
    expect(value.getLeaves).toHaveBeenCalledOnce();
    expect(changes).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
    observer.disconnect();
    value.cleanup();
    vi.restoreAllMocks();
  }
});

it(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz: bounds observed content width transitions without synchronous layout reads or frame work`, () => {
  installObsidianDomHelpers();
  const boundary = documentStatusBarMotionFixture();
  const container = document.body.createDiv();
  const status = new WorkspaceDocumentStatus();
  const geometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
  const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get");
  const clientWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get");
  const frames = vi.spyOn(window, "requestAnimationFrame");
  const timers = vi.spyOn(window, "setTimeout");
  const intervals = vi.spyOn(window, "setInterval");
  const { dispose } = mountDocumentStatusBar(container, status);
  const root = container.firstElementChild as HTMLElement;
  boundary.attach(root);
  try {
    boundary.resize(50);
    boundary.resize(100);
    const first = boundary.animations[0]!;
    for (let index = 0; index < 10_000; index += 1) {
      boundary.resize(100);
      status.setActivePane(container);
    }
    expect(boundary.construct).toHaveBeenCalledOnce();
    expect(boundary.observe).toHaveBeenCalledExactlyOnceWith(root.firstElementChild);
    expect(boundary.animate).toHaveBeenCalledOnce();
    expect(first.effect.getComputedTiming).not.toHaveBeenCalled();
    expect(first.cancel).not.toHaveBeenCalled();
    boundary.resize(80);
    expect(first.effect.getComputedTiming).toHaveBeenCalledOnce();
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(first.onfinish).toBeNull();
    const second = boundary.animations[1]!;
    expect(second.cancel).not.toHaveBeenCalled();
    second.onfinish?.();
    expect(second.cancel).toHaveBeenCalledOnce();
    boundary.resize(120);
    dispose();
    dispose();
    boundary.resize(160);
    expect(boundary.animate).toHaveBeenCalledTimes(3);
    expect(boundary.animations[2]?.cancel).toHaveBeenCalledOnce();
    expect(boundary.disconnect).toHaveBeenCalledOnce();
    expect(boundary.query.removeEventListener).toHaveBeenCalledOnce();
    expect(geometry).not.toHaveBeenCalled();
    expect(width).not.toHaveBeenCalled();
    expect(clientWidth).not.toHaveBeenCalled();
    expect(frames).not.toHaveBeenCalled();
    expect(timers).not.toHaveBeenCalled();
    expect(intervals).not.toHaveBeenCalled();
  } finally {
    dispose();
    status.dispose();
    container.remove();
    boundary.cleanup();
    vi.restoreAllMocks();
  }
});

it(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz: bounds native save-status DOM work across 10,000 commits and layout refreshes and preserves inactivity debounce`, () => {
  installObsidianDomHelpers();
  const container = document.body.createDiv();
  const status = new DocumentSaveStatusSource();
  const workspaceStatus = new WorkspaceDocumentStatus();
  const subscribe = vi.fn(status.subscribe);
  const unsubscribe = vi.fn();
  const attachment = {
    attachmentGeneration: 1,
    attachmentId: "embed-a",
    documentId: "drawing.svg",
    root: container,
  };
  const model = {
    getSaveStatus: status.current,
    subscribeSaveStatus: (listener: () => void) => {
      const release = subscribe(listener);
      return () => {
        unsubscribe();
        release();
      };
    },
  };
  workspaceStatus.bind(attachment, model);
  const icons = mockNativeStatusIcon();
  const containment = vi.spyOn(container, "contains");
  const { dispose } = mountDocumentStatusBar(container, workspaceStatus);
  const root = container.firstElementChild as HTMLElement;
  const icon = root.querySelector(".inkbook-status-bar-icon")!;
  const geometry = vi.spyOn(SVGElement.prototype, "getBoundingClientRect");
  const observer = new MutationObserver(() => undefined);
  observer.observe(root, { attributes: true, childList: true, subtree: true });
  const documentSource = new AutosaveDocumentFixture();
  const clock = new FakeClock();
  const serialized = serializeSnapshot();
  const execute = vi.fn(() => new Promise<never>(() => undefined));
  const coordinator = new AutosaveCoordinator({
    clock,
    confirmedBase: { outputHash: serialized.hash, revision: 0, type: "confirmed" },
    documentSource,
    executor: { execute, terminate: vi.fn() },
    initialSnapshot: documentSource.snapshot(),
    observer: {
      statusChanged: (value) => status.update({ dirty: coordinator.dirty, status: value }),
    },
    path: "drawing.svg",
    sessionId: "session-a",
    vault: new MemoryVault(serialized.svg),
    workScheduler: createTestWorkScheduler(),
  });
  try {
    for (let revision = 1; revision <= 10_000; revision += 1) {
      documentSource.commit(revision, 100);
      coordinator.recordCommit({ modelRevision: revision });
      workspaceStatus.setActivePane(container);
    }
    expect(root.dataset.saveStatus).toBe("pending");
    // One transition updates content and normalizes the new SVG in three attribute writes.
    expect(observer.takeRecords().length).toBeLessThanOrEqual(9);
    expect(icons).toHaveBeenCalledTimes(2);
    expectNormalizedIcon(icon, "1 1 22 22");
    const pendingGlyph = verifyRetainedStatusNodes(workspaceStatus, container, root, observer);
    attachment.documentId = "renamed.svg";
    workspaceStatus.setActivePane(container);
    const pathChanges = observer.takeRecords();
    expect(pathChanges).toHaveLength(1);
    expect(pathChanges[0]?.attributeName).toBe("title");
    expect(icon.firstElementChild).toBe(pendingGlyph);
    expect(subscribe).toHaveBeenCalledOnce();
    expect(containment).toHaveBeenCalledOnce();
    clock.advance(999);
    expect(execute).not.toHaveBeenCalled();
    expect(observer.takeRecords()).toHaveLength(0);
    clock.advance(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(root.dataset.saveStatus).toBe("saving");
    expect(observer.takeRecords().length).toBeLessThanOrEqual(9);
    expect(icons).toHaveBeenCalledTimes(3);
    expectNormalizedIcon(icon, "2 2 20 20");
    expect(geometry).not.toHaveBeenCalled();
    expect(containment).toHaveBeenCalledOnce();
    dispose();
    dispose();
    workspaceStatus.dispose();
    workspaceStatus.dispose();
    status.update({ dirty: true, status: "executor-failed" });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(container.children).toHaveLength(0);
    expect(observer.takeRecords()).toHaveLength(0);
    expect(icons).toHaveBeenCalledTimes(3);
  } finally {
    observer.disconnect();
    dispose();
    workspaceStatus.dispose();
    status.dispose();
    coordinator.dispose();
    container.remove();
    vi.restoreAllMocks();
  }
});
