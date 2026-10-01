// @vitest-environment happy-dom

import * as obsidian from "obsidian";
import { expect, it, vi } from "vitest";

import { DocumentSaveStatusSource } from "../../../../src/obsidian/embeds/document-save-status";
import { WorkspaceDocumentStatus } from "../../../../src/obsidian/embeds/workspace-document-status";
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
  workspaceStatus.bind({ ...attachment }, model);
  const icons = vi.spyOn(obsidian, "setIcon");
  const containment = vi.spyOn(container, "contains");
  const dispose = mountDocumentStatusBar(container, workspaceStatus);
  const root = container.firstElementChild as HTMLElement;
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
    // One semantic transition may update status, label, title, icon visibility and icon content.
    expect(observer.takeRecords().length).toBeLessThanOrEqual(6);
    expect(icons).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(containment).toHaveBeenCalledOnce();
    clock.advance(999);
    expect(execute).not.toHaveBeenCalled();
    expect(observer.takeRecords()).toHaveLength(0);
    clock.advance(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(root.dataset.saveStatus).toBe("saving");
    expect(observer.takeRecords().length).toBeLessThanOrEqual(6);
    expect(icons).toHaveBeenCalledTimes(2);
    expect(containment).toHaveBeenCalledOnce();
    dispose();
    dispose();
    workspaceStatus.dispose();
    workspaceStatus.dispose();
    status.update({ dirty: true, status: "executor-failed" });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(container.children).toHaveLength(0);
    expect(observer.takeRecords()).toHaveLength(0);
    expect(icons).toHaveBeenCalledTimes(2);
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
