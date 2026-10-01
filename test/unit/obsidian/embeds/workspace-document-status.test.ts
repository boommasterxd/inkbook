// @vitest-environment happy-dom

import { expect, it, vi } from "vitest";

import type { DocumentSaveStatus } from "../../../../src/editor/session/session-port";
import { WorkspaceDocumentStatus } from "../../../../src/obsidian/embeds/workspace-document-status";
import { createHtmlElement } from "../../../adapters/obsidian/dom";

function fixture(status: DocumentSaveStatus = "saved") {
  let value = status;
  let listener = (): void => undefined;
  const unsubscribe = vi.fn();
  const model = {
    getSaveStatus: () => value,
    subscribeSaveStatus: vi.fn((next: () => void) => {
      listener = next;
      return unsubscribe;
    }),
  };
  return {
    model,
    unsubscribe,
    update(next: DocumentSaveStatus): void {
      value = next;
      listener();
    },
  };
}

function attachment(attachmentGeneration = 1) {
  return {
    attachmentGeneration,
    attachmentId: "embed-a",
    documentId: "Sketches/Drawing.svg",
    root: createHtmlElement("div"),
  };
}

function boundPane() {
  const source = new WorkspaceDocumentStatus();
  const current = attachment();
  const pane = createHtmlElement("div");
  pane.append(current.root);
  const drawing = fixture();
  const changes = vi.fn();
  source.subscribe(changes);
  source.setActivePane(pane);
  source.bind(current, drawing.model);
  return { source, current, pane, drawing, changes };
}

it("publishes attached save transitions and reuses an identical binding", () => {
  const source = new WorkspaceDocumentStatus();
  const current = attachment();
  const document = fixture();
  const changes = vi.fn();
  source.subscribe(changes);
  expect(source.current()).toBeNull();
  source.bind(current, document.model);
  expect(source.current()).toEqual({ path: current.documentId, status: "saved" });
  source.bind({ ...current }, document.model);
  expect(document.model.subscribeSaveStatus).toHaveBeenCalledOnce();
  expect(changes).toHaveBeenCalledOnce();
  for (const status of ["pending", "saving", "failed", "saved"] as const) {
    document.update(status);
    expect(source.current()).toEqual({ path: current.documentId, status });
  }
  expect(changes).toHaveBeenCalledTimes(5);
  source.detach(current);
  source.detach(current);
  expect(source.current()).toBeNull();
  expect(changes).toHaveBeenCalledTimes(6);
  expect(document.unsubscribe).toHaveBeenCalledOnce();
  source.dispose();
});

it("rejects stale callbacks and detach identities after replacing attachment or model", () => {
  const source = new WorkspaceDocumentStatus();
  const first = fixture();
  const second = fixture("pending");
  const oldAttachment = attachment();
  const current = attachment(2);
  const changes = vi.fn();
  source.subscribe(changes);
  source.bind(oldAttachment, first.model);
  source.bind(current, second.model);
  expect(first.unsubscribe).toHaveBeenCalledOnce();
  source.detach(oldAttachment);
  source.detach({ ...current, attachmentId: "other-embed" });
  first.update("failed");
  expect(source.current()).toEqual({ path: current.documentId, status: "pending" });
  expect(changes).toHaveBeenCalledTimes(2);
  source.bind(current, first.model);
  expect(second.unsubscribe).toHaveBeenCalledOnce();
  second.update("saving");
  expect(source.current()).toEqual({ path: current.documentId, status: "failed" });
  expect(changes).toHaveBeenCalledTimes(3);
  source.dispose();
  expect(first.unsubscribe).toHaveBeenCalledTimes(2);
});

it("shows only the active pane and restores the latest state without resubscribing", () => {
  const { source, current, pane, drawing, changes } = boundPane();
  source.setActivePane(createHtmlElement("div"));
  expect(source.current()).toBeNull();
  drawing.update("pending");
  drawing.update("saving");
  expect(changes).toHaveBeenCalledTimes(2);
  source.setActivePane(pane);
  source.setActivePane(pane);
  expect(source.current()).toEqual({ path: current.documentId, status: "saving" });
  expect(changes).toHaveBeenCalledTimes(3);
  expect(drawing.model.subscribeSaveStatus).toHaveBeenCalledOnce();
  source.setActivePane(null);
  expect(source.current()).toBeNull();
  source.dispose();
});

it("retains logical ownership while the host removes and reinserts the root", () => {
  const { source, current, pane, drawing, changes } = boundPane();
  current.root.remove();
  source.setActivePane(pane);
  drawing.update("pending");
  expect(source.current()).toEqual({ path: current.documentId, status: "pending" });
  expect(changes).toHaveBeenCalledTimes(2);
  source.setActivePane(null);
  expect(source.current()).toBeNull();
  source.setActivePane(pane);
  expect(source.current()).toEqual({ path: current.documentId, status: "pending" });
  pane.append(current.root);
  source.setActivePane(pane);
  source.setActivePane(pane);
  expect(source.current()).toEqual({ path: current.documentId, status: "pending" });
  expect(changes).toHaveBeenCalledTimes(4);
  expect(drawing.model.subscribeSaveStatus).toHaveBeenCalledOnce();
  source.dispose();
});

it("resolves a background binding owner once and reuses it across status and pane changes", () => {
  const current = attachment();
  const pane = createHtmlElement("div");
  const other = createHtmlElement("div");
  pane.append(current.root);
  const resolve = vi.fn(() => pane);
  const source = new WorkspaceDocumentStatus(resolve);
  const drawing = fixture();
  source.setActivePane(other);
  source.bind(current, drawing.model);
  source.bind({ ...current }, drawing.model);
  expect(source.current()).toBeNull();
  current.root.remove();
  drawing.update("failed");
  source.setActivePane(pane);
  expect(source.current()).toEqual({ path: current.documentId, status: "failed" });
  expect(resolve).toHaveBeenCalledOnce();
  source.detach(current);
  expect(source.current()).toBeNull();
  expect(drawing.unsubscribe).toHaveBeenCalledOnce();
  source.dispose();
});

it("waits for unknown membership, caches its first owning pane and resets on rebinding", () => {
  const current = attachment();
  const pane = createHtmlElement("div");
  const other = createHtmlElement("div");
  const resolve = vi.fn(() => undefined);
  const source = new WorkspaceDocumentStatus(resolve);
  const drawing = fixture();
  source.setActivePane(pane);
  source.bind(current, drawing.model);
  expect(source.current()).toBeNull();
  pane.append(current.root);
  source.setActivePane(pane);
  expect(source.current()?.status).toBe("saved");
  source.bind(attachment(2), drawing.model);
  expect(source.current()).toBeNull();
  source.setActivePane(other);
  expect(source.current()).toBeNull();
  expect(resolve).toHaveBeenCalledTimes(2);
  source.dispose();
});

it("handles unsupported status and releases listeners and model subscription once", () => {
  const source = new WorkspaceDocumentStatus();
  const current = attachment();
  const drawing = fixture();
  const removed = vi.fn();
  const changes = vi.fn();
  source.subscribe(removed)();
  source.subscribe(changes);
  source.bind(current, {});
  expect(source.current()).toBeNull();
  source.bind(current, drawing.model);
  expect(removed).not.toHaveBeenCalled();
  source.dispose();
  source.dispose();
  const notifications = changes.mock.calls.length;
  source.subscribe(removed);
  source.bind(attachment(2), drawing.model);
  source.detach(current);
  source.setActivePane(null);
  drawing.update("failed");
  expect(source.current()).toBeNull();
  expect(drawing.unsubscribe).toHaveBeenCalledOnce();
  expect(drawing.model.subscribeSaveStatus).toHaveBeenCalledOnce();
  expect(changes).toHaveBeenCalledTimes(notifications);
  expect(removed).not.toHaveBeenCalled();
});
