// @vitest-environment happy-dom

import * as obsidian from "obsidian";
import { MotionGlobalConfig } from "motion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { DocumentSaveStatusSource } from "../../../../src/obsidian/embeds/document-session/document-save-status";
import { WorkspaceDocumentStatus } from "../../../../src/obsidian/embeds/workspace/workspace-document-status";
import { mountDocumentStatusBar } from "../../../../src/obsidian/runtime/document-status-bar";
import { AutosaveCoordinator } from "../../../../src/persistence/saving/autosave/public";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { documentStatusBarBindingFixture } from "../../../fixtures/obsidian/document-status-bar-binding";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import {
  AutosaveDocumentFixture,
  FakeClock,
  MemoryVault,
  serializeSnapshot,
} from "../../../integration/persistence/saving/fixtures";
import { INTERACTION_REFRESH_PROFILE } from "../../interaction-refresh-profile";

beforeEach(() => {
  MotionGlobalConfig.useManualTiming = true;
});
afterEach(() => {
  MotionGlobalConfig.useManualTiming = false;
});

function currentStatusContent(root: HTMLElement): HTMLElement {
  return root.querySelector<HTMLElement>(
    `.inkbook-status-bar-content[data-save-status='${root.dataset.saveStatus}']`,
  )!;
}

function currentStatusIcon(root: HTMLElement): Element {
  return currentStatusContent(root).querySelector(".inkbook-status-bar-icon")!;
}

function expectReleasedPalette(observer: MutationObserver, palette: Element): void {
  // Unmount removes the owned palette from the detached status root exactly once.
  const changes = observer.takeRecords();
  expect(changes).toHaveLength(1);
  expect([...changes[0]!.removedNodes]).toEqual([palette]);
  expect(changes[0]!.addedNodes).toHaveLength(0);
}

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
  const content = currentStatusContent(root);
  const icon = content.querySelector(".inkbook-status-bar-icon")!;
  const glyph = icon.firstElementChild;
  const label = content.querySelector(".inkbook-status-bar-label")!;
  for (let index = 0; index < 10_000; index += 1) workspace.setActivePane(container);
  expect(observer.takeRecords()).toHaveLength(0);
  expect(icon.firstElementChild).toBe(glyph);
  expect(currentStatusContent(root).querySelector(".inkbook-status-bar-label")).toBe(label);
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
    expect(observer.takeRecords().length).toBeLessThanOrEqual(9);
    expect(icons).toHaveBeenCalledTimes(2);
    const icon = currentStatusIcon(root);
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
    expectNormalizedIcon(currentStatusIcon(root), "2 2 20 20");
    expect(geometry).not.toHaveBeenCalled();
    expect(containment).toHaveBeenCalledOnce();
    const palette = root.querySelector("[hidden][aria-hidden='true']")!;
    dispose();
    dispose();
    workspaceStatus.dispose();
    workspaceStatus.dispose();
    status.update({ dirty: true, status: "executor-failed" });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(container.children).toHaveLength(0);
    expectReleasedPalette(observer, palette);
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
