// @vitest-environment happy-dom
import { sys } from "typescript";
import type { Window as HappyDomWindow } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InkbookFeedbackManager } from "../../../../src/obsidian/feedback";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

beforeEach(() => {
  installObsidianDomHelpers();
  vi.useFakeTimers();
  const stylesheet = new CSSStyleSheet();
  stylesheet.replaceSync(sys.readFile(sys.resolvePath("src/obsidian/styles/feedback.css")) ?? "");
  document.adoptedStyleSheets = [stylesheet];
});
afterEach(() => {
  document.body.replaceChildren();
  document.body.className = "";
  document.adoptedStyleSheets = [];
  vi.useRealTimers();
});

describe("window feedback interaction", () => {
  it.each(["desktop", "tablet", "phone"])(
    "keeps %s feedback interactive outside the drawing without intercepting the window",
    (mode) => {
      (window as unknown as HappyDomWindow).happyDOM.setViewport({
        width: mode === "phone" ? 360 : 1600,
        height: 900,
      });
      if (mode !== "desktop") document.body.classList.add("is-mobile", `is-${mode}`);
      const root = document.body.createDiv({ cls: "inkbook-root" });
      const indicator = root.createDiv({ cls: "inkbook-operation-feedback" });
      const manager = new InkbookFeedbackManager();
      manager.showInPresentation(root, {
        actions: [
          { id: "retry-save", run: () => false },
          { id: "save-copy", run: () => false },
          { id: "continue-editing", run: () => false },
        ],
        code: "drawing-load-failed",
      });
      const host = document.querySelector<HTMLElement>(".inkbook-feedback-host")!;
      const feedback = host.querySelector<HTMLElement>(".inkbook-feedback")!;
      const style = window.getComputedStyle(host);

      expect(host.parentElement).toBe(document.body);
      expect(style.position).toBe("fixed");
      expect(style.alignItems).toBe(mode === "phone" ? "center" : "flex-end");
      expect(style.pointerEvents).toBe("none");
      expect(window.getComputedStyle(feedback).pointerEvents).toBe("auto");
      expect(window.getComputedStyle(feedback).flexWrap).toBe(mode === "phone" ? "wrap" : "nowrap");
      const actions = feedback.querySelector<HTMLElement>(".inkbook-feedback-actions")!;
      expect(window.getComputedStyle(actions).flexWrap).toBe("nowrap");
      expect(window.getComputedStyle(actions).flexShrink).toBe("0");
      expect(window.getComputedStyle(actions).flexBasis).toBe(mode === "phone" ? "100%" : "auto");
      if (mode === "phone") {
        expect(window.getComputedStyle(actions).justifyContent).toBe("space-evenly");
        expect(Number.parseFloat(window.getComputedStyle(actions).gap)).toBe(0);
      }
      expect(actions.children).toHaveLength(3);
      expect(window.getComputedStyle(feedback).inlineSize).toBe("100%");
      expect(window.getComputedStyle(feedback).minBlockSize).toBe("64px");
      expect(window.getComputedStyle(feedback.parentElement!).inlineSize).toBe("max-content");
      expect(root.contains(feedback)).toBe(false);
      manager.dispose();
      expect(host.isConnected).toBe(false);
      expect(indicator.parentElement).toBe(root);
    },
  );
});

describe("window feedback lifecycle", () => {
  it("tracks source scheme and motion while open and releases the observer on disposal", async () => {
    const root = document.body.createDiv();
    root.dataset.inkbookScheme = "light";
    root.dataset.inkbookMotion = "full";
    const manager = new InkbookFeedbackManager();
    manager.showInPresentation(root, {
      actions: [{ id: "dismiss", run: () => false }],
      code: "drawing-load-failed",
    });
    const slot = document.querySelector<HTMLElement>(".inkbook-feedback-slot")!;
    expect(slot.dataset.inkbookScheme).toBe("light");
    root.dataset.inkbookScheme = "dark";
    root.dataset.inkbookMotion = "reduced";
    await vi.advanceTimersByTimeAsync(0);
    expect(slot.dataset.inkbookScheme).toBe("dark");
    expect(slot.dataset.inkbookMotion).toBe("reduced");
    delete root.dataset.inkbookMotion;
    await vi.advanceTimersByTimeAsync(0);
    expect(slot.dataset.inkbookMotion).toBeUndefined();
    manager.dispose();
    root.dataset.inkbookScheme = "light";
    await vi.advanceTimersByTimeAsync(0);
    expect(slot.dataset.inkbookScheme).toBe("dark");
  });

  it("ignores detached actions and late completion after presentation replacement", async () => {
    const manager = new InkbookFeedbackManager();
    const root = document.body.createDiv();
    let finish: (() => void) | undefined;
    const retry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    manager.showInPresentation(root, {
      actions: [{ id: "retry-open", run: retry }],
      code: "drawing-load-failed",
    });
    const stale = document.querySelector<HTMLButtonElement>("button")!;
    stale.click();
    manager.showInPresentation(root, {
      actions: [{ id: "dismiss", run: () => false }],
      code: "clipboard-paste-stale",
    });
    stale.dispatchEvent(new Event("click"));
    finish?.();
    await Promise.resolve();
    vi.runAllTimers();

    expect(retry).toHaveBeenCalledOnce();
    expect(document.querySelectorAll(".inkbook-feedback")).toHaveLength(1);
    expect(document.querySelector(".inkbook-feedback-title")?.textContent).toBe(
      "Paste stopped because the drawing changed.",
    );
    manager.dispose();
    expect(document.querySelector(".inkbook-feedback-host")).toBeNull();
  });
});
