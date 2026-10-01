// @vitest-environment happy-dom

import * as obsidian from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  WorkspaceDocumentSaveStatus,
  WorkspaceDocumentSaveStatusSource,
} from "../../../../src/obsidian/embeds/workspace-document-status";
import { mountDocumentStatusBar } from "../../../../src/obsidian/runtime/document-status-bar";
import type { MotionPreference } from "../../../../src/rendering/motion/transitions";
import { createHtmlElement, installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

const cleanups: (() => void)[] = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function fixture(
  initial: WorkspaceDocumentSaveStatus = null,
  readPreference?: () => MotionPreference,
) {
  installObsidianDomHelpers();
  let value = initial;
  let listener = (): void => undefined;
  const unsubscribe = vi.fn();
  const source: WorkspaceDocumentSaveStatusSource = {
    current: () => value,
    subscribe: (next) => {
      listener = next;
      return unsubscribe;
    },
  };
  const container = createHtmlElement("div");
  document.body.append(container);
  const dispose = mountDocumentStatusBar(container, source, readPreference);
  cleanups.push(dispose);
  const root = container.firstElementChild as HTMLElement;
  const icon = root.firstElementChild as HTMLElement;
  const label = root.lastElementChild as HTMLElement;
  return {
    container,
    dispose,
    icon,
    label,
    root,
    unsubscribe,
    update: (next: WorkspaceDocumentSaveStatus): void => {
      value = next;
      listener();
    },
  };
}

describe("native document status bar", () => {
  it("identifies Inkbook and the active document through every save transition", () => {
    const { root, icon, label, update } = fixture();
    expect(root.getAttribute("role")).toBe("status");
    expect(root.getAttribute("aria-label")).toBe("Inkbook save status");
    expect(root.getAttribute("aria-live")).toBe("polite");
    expect(root.getAttribute("aria-atomic")).toBe("true");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(root.dataset.saveStatus).toBe("inactive");
    expect(label.textContent).toBe("No Inkbook embed open");
    expect(root.dataset.inkbookMotion).toBe("system");
    expect(icon.hidden).toBe(true);

    const path = "Sketches/Notebook.svg";
    for (const [status, text, glyph] of [
      ["saved", "Saved", "check"],
      ["pending", "Unsaved changes", "pencil"],
      ["saving", "Saving…", "loader-circle"],
      ["failed", "Save failed", "circle-alert"],
      ["saved", "Saved", "check"],
    ] as const) {
      update({ path, status });
      expect(root.dataset.saveStatus).toBe(status);
      expect(label.textContent).toBe(text);
      expect(label.textContent).not.toContain(path);
      expect(root.title).toBe(`Inkbook: ${text}\n${path}`);
      expect(icon.hidden).toBe(false);
      expect(icon.dataset.icon).toBe(glyph);
    }
    update(null);
    expect(root.dataset.saveStatus).toBe("inactive");
    expect(icon.hidden).toBe(true);
    expect(root.title).toBe("No Inkbook embed open");
  });

  it.each(["saved", "pending"] as const)(
    "retains nodes and skips unchanged %s DOM and icon work, including path-only updates",
    (status) => {
      const icons = vi.spyOn(obsidian, "setIcon");
      const saved = { path: "First.svg", status };
      const { root, icon, label, update } = fixture(saved);
      const observer = new MutationObserver(() => undefined);
      observer.observe(root, { attributes: true, childList: true, subtree: true });
      for (let index = 0; index < 100; index += 1) update({ ...saved });
      expect(observer.takeRecords()).toHaveLength(0);
      expect(icons).toHaveBeenCalledOnce();
      update({ path: "Second.svg", status });
      const changes = observer.takeRecords();
      expect(changes).toHaveLength(1);
      expect(changes[0]?.attributeName).toBe("title");
      expect(root.title).toContain("Second.svg");
      expect(icons).toHaveBeenCalledOnce();
      expect(root.firstElementChild).toBe(icon);
      expect(root.lastElementChild).toBe(label);
      observer.disconnect();
    },
  );

  it("releases its subscription and owned node once and ignores late notifications", () => {
    const { container, dispose, root, unsubscribe, update } = fixture();
    const sibling = createHtmlElement("span");
    container.append(sibling);
    dispose();
    dispose();
    update({ path: "Closed.svg", status: "failed" });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild).toBe(sibling);
    expect(root.dataset.saveStatus).toBe("inactive");
  });

  it("applies the current motion preference without redundant mutations", () => {
    let motion: MotionPreference = "reduced";
    const { root, update } = fixture(null, () => motion);
    expect(root.dataset.inkbookMotion).toBe("reduced");
    motion = "full";
    update(null);
    expect(root.dataset.inkbookMotion).toBe("full");
    motion = "system";
    update(null);
    expect(root.dataset.inkbookMotion).toBe("system");
  });
});
