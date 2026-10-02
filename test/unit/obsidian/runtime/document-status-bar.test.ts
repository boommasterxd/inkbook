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

function mockNativeStatusIcon() {
  const setIcon = obsidian.setIcon;
  const measure = vi.fn();
  let glyph: SVGPathElement;
  vi.spyOn(obsidian, "setIcon").mockImplementation((element, name) => {
    setIcon(element, name);
    const svg = document.importNode(
      new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M 6 12 L 10 16 L 18 8"/></svg>',
        "image/svg+xml",
      ).documentElement,
      true,
    );
    Object.assign(svg, { getBBox: measure });
    glyph = svg.firstElementChild as SVGPathElement;
    element.replaceChildren(svg);
  });
  return { measure, glyph: () => glyph };
}

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
  const { dispose } = mountDocumentStatusBar(container, source, readPreference);
  cleanups.push(dispose);
  const root = container.firstElementChild as HTMLElement;
  const content = root.firstElementChild as HTMLElement;
  const icon = content.firstElementChild as HTMLElement;
  const label = content.lastElementChild as HTMLElement;
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
    const nativeIcon = mockNativeStatusIcon();
    const geometry = vi.spyOn(SVGElement.prototype, "getBoundingClientRect");
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
    for (const [status, text, name, viewBox] of [
      ["saved", "Saved", "check", "3 5 18 13"],
      ["pending", "Unsaved changes", "pencil", "1 1 22 22"],
      ["saving", "Saving…", "loader-circle", "2 2 20 20"],
      ["failed", "Save failed", "circle-alert", "1 1 22 22"],
      ["saved", "Saved", "check", "3 5 18 13"],
    ] as const) {
      update({ path, status });
      expect(root.dataset.saveStatus).toBe(status);
      expect(label.textContent).toBe(text);
      expect(label.textContent).not.toContain(path);
      expect(root.title).toBe(`Inkbook: ${text}\n${path}`);
      expect(icon.hidden).toBe(false);
      expect(icon.dataset.icon).toBe(name);
      const svg = icon.querySelector("svg")!;
      expect(svg.getAttribute("viewBox")).toBe(viewBox);
      expect(svg.hasAttribute("width")).toBe(false);
      expect(svg.hasAttribute("height")).toBe(false);
      expect(svg.firstElementChild).toBe(nativeIcon.glyph());
      expect(svg.firstElementChild?.getAttribute("d")).toBe("M 6 12 L 10 16 L 18 8");
      expect(svg.getAttribute("stroke")).toBe("currentColor");
      expect(svg.getAttribute("stroke-width")).toBe("2");
      expect(svg.getAttribute("stroke-linecap")).toBe("round");
    }
    update(null);
    expect(root.dataset.saveStatus).toBe("inactive");
    expect(icon.hidden).toBe(true);
    expect(root.title).toBe("No Inkbook embed open");
    expect(icon.childElementCount).toBe(0);
    expect(nativeIcon.measure).not.toHaveBeenCalled();
    expect(geometry).not.toHaveBeenCalled();
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
      expect(root.firstElementChild?.firstElementChild).toBe(icon);
      expect(root.firstElementChild?.lastElementChild).toBe(label);
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
