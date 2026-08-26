import { describe, expect, it, vi } from "vitest";

import { InkbookFeedbackManager } from "../../../../src/obsidian/feedback";
import { FakePresentationElement } from "../../../fixtures/obsidian/presentation-dom";

describe("Inkbook feedback manager", () => {
  it("renders one accessible icon-action message inside a presentation", async () => {
    const root = new FakePresentationElement();
    const retry = vi.fn(() => true);
    const manager = new InkbookFeedbackManager();

    manager.showInPresentation(root as unknown as HTMLElement, {
      actions: [{ id: "retry-save", run: retry }],
      code: "changes-save-failed",
    });

    const feedback = root.getElementsByClassName("inkbook-feedback").item(0);
    const buttons = feedback?.getElementsByTagName("button");
    expect(feedback?.style.insetBlockEnd).toBe("16px");
    expect(feedback?.style.insetInlineStart).toBe("300px");
    expect(feedback?.style.maxInlineSize).toBe("576px");
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
});

describe("Inkbook feedback routing and cleanup", () => {
  it("anchors non-presentation feedback to the active view or owning window", () => {
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

    manager.showInViewOrWindow(ownerWindow, view as unknown as HTMLElement, {
      actions: [action],
      code: "placement-folder-fallback",
    });
    expect(view.getElementsByClassName("inkbook-feedback-host-view").length).toBe(1);

    manager.showInViewOrWindow(ownerWindow, undefined, {
      actions: [action],
      code: "recovery-copy-saved",
    });
    expect(view.getElementsByClassName("inkbook-feedback-host-view").length).toBe(0);
    expect(
      (body as unknown as FakePresentationElement).getElementsByClassName(
        "inkbook-feedback-host-window",
      ).length,
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
