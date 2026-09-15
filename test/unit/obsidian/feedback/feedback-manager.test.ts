import { describe, expect, it, vi } from "vitest";

import { InkbookFeedbackManager } from "../../../../src/obsidian/feedback";
import { FakePresentationElement } from "../../../fixtures/obsidian/presentation-dom";

describe("Inkbook feedback manager", () => {
  it("renders one accessible icon-action message in the owning window", async () => {
    const root = new FakePresentationElement();
    const retry = vi.fn(() => true);
    const manager = new InkbookFeedbackManager();

    manager.showInPresentation(root as unknown as HTMLElement, {
      actions: [{ id: "retry-save", run: retry }],
      code: "changes-save-failed",
    });

    const feedback = root.getElementsByClassName("inkbook-feedback").item(0);
    const buttons = feedback?.getElementsByTagName("button");
    expect(feedback?.style.insetBlockEnd).toBe("");
    expect(root.getElementsByClassName("inkbook-feedback-host").length).toBe(1);
    expect(feedback?.attributes.get("role")).toBe("alert");
    expect(feedback?.dataset.inkbookFeedbackSeverity).toBe("error");
    expect(feedback?.textContent).toBe("");
    expect(feedback?.getElementsByClassName("inkbook-feedback-title").item(0)?.textContent).toBe(
      "Changes couldn't be saved.",
    );
    expect(feedback?.getElementsByClassName("inkbook-feedback-detail").item(0)?.textContent).toBe(
      "Your changes are still available in the editor.",
    );
    expect(buttons?.item(0)?.attributes.get("aria-label")).toBe("Retry save");
    expect(buttons?.item(0)?.children[0]?.attributes.get("data-icon")).toBe("rotate-ccw");

    buttons?.item(0)?.dispatch("click");
    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
    expect(root.getElementsByClassName("inkbook-feedback").length).toBe(0);
  });

  it("replaces an existing presentation message instead of stacking it", () => {
    const root = new FakePresentationElement();
    const manager = new InkbookFeedbackManager();
    const keepOpen = { id: "dismiss", run: () => false } as const;

    manager.showInPresentation(root as unknown as HTMLElement, {
      actions: [keepOpen],
      code: "clipboard-paste-read-failed",
    });
    manager.showInPresentation(root as unknown as HTMLElement, {
      actions: [keepOpen],
      code: "clipboard-paste-stale",
    });

    expect(root.getElementsByClassName("inkbook-feedback").length).toBe(1);
    expect(root.getElementsByClassName("inkbook-feedback-title").item(0)?.textContent).toBe(
      "Paste stopped because the drawing changed.",
    );
  });

  it("keeps a closed message as an inaccessible exit surface until toolbar motion completes", () => {
    const root = new FakePresentationElement();
    const ownerWindow = root.ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("Missing owner window.");
    const scheduled: Array<() => void> = [];
    (ownerWindow as unknown as { setTimeout(callback: () => void): number }).setTimeout = (
      callback,
    ) => {
      scheduled.push(callback);
      return 1;
    };
    const manager = new InkbookFeedbackManager();
    const handle = manager.showInPresentation(root as unknown as HTMLElement, {
      actions: [{ id: "dismiss", run: () => true }],
      code: "clipboard-paste-read-failed",
    });

    handle.close();

    const feedback = root.getElementsByClassName("inkbook-feedback").item(0);
    expect(feedback?.dataset.inkbookFeedbackPresence).toBe("exiting");
    expect(feedback?.attributes.get("aria-hidden")).toBe("true");
    expect(root.getElementsByClassName("inkbook-feedback").length).toBe(1);
    scheduled[0]?.();
    expect(root.getElementsByClassName("inkbook-feedback").length).toBe(0);
  });
});

describe("Inkbook feedback routing and cleanup", () => {
  it("mounts global feedback outside the active view and replaces its window slot", () => {
    const root = new FakePresentationElement();
    const ownerDocument = root.ownerDocument as Document & { body: HTMLElement };
    const body = new FakePresentationElement(ownerDocument) as unknown as HTMLElement;
    ownerDocument.body = body;
    const view = new FakePresentationElement(ownerDocument);
    (body as unknown as FakePresentationElement).append(view);
    const ownerWindow = ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("Missing owner window.");
    const manager = new InkbookFeedbackManager();
    const action = { id: "dismiss", run: () => false } as const;

    manager.showInWindow(ownerWindow, {
      actions: [action],
      code: "placement-folder-fallback",
    });
    expect(view.getElementsByClassName("inkbook-feedback").length).toBe(0);
    expect(body.getElementsByClassName("inkbook-feedback").length).toBe(1);

    manager.showInWindow(ownerWindow, {
      actions: [action],
      code: "recovery-copy-saved",
    });
    expect(body.getElementsByClassName("inkbook-feedback").length).toBe(1);
    expect(
      (body as unknown as FakePresentationElement).getElementsByClassName("inkbook-feedback-host")
        .length,
    ).toBe(1);
  });

  it("keeps a failed asynchronous action visible and removes all feedback on disposal", async () => {
    const root = new FakePresentationElement();
    const manager = new InkbookFeedbackManager();
    manager.showInPresentation(root as unknown as HTMLElement, {
      actions: [
        {
          id: "retry-open",
          run: async () => Promise.reject(new Error("failed")),
        },
      ],
      code: "drawing-load-failed",
    });

    root.getElementsByTagName("button").item(0)?.dispatch("click");
    await vi.waitFor(() => expect(root.getElementsByClassName("inkbook-feedback").length).toBe(1));
    manager.dispose();
    expect(root.getElementsByClassName("inkbook-feedback").length).toBe(0);
  });
});
