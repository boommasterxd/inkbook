import { describe, expect, it } from "vitest";

import { InkbookFeedbackManager } from "../../../../src/obsidian/feedback";
import { mountWindowFeedback } from "../../../../src/obsidian/feedback/window-feedback-host";
import { FakePresentationElement } from "../../../fixtures/obsidian/presentation-dom";

function presentation(body: FakePresentationElement): FakePresentationElement {
  const root = new FakePresentationElement(body.ownerDocument);
  body.append(root);
  return root;
}

function html(element: FakePresentationElement): HTMLElement {
  return element as unknown as HTMLElement;
}

const request = {
  actions: [{ id: "dismiss", run: () => false }],
  code: "drawing-load-failed",
} as const;

describe("window feedback ownership", () => {
  it("shares the window host while retaining independent presentation styling and cleanup", () => {
    const body = new FakePresentationElement();
    const root = presentation(body);
    root.dataset.inkbookScheme = "dark";
    root.dataset.inkbookMotion = "reduced";
    const first = root.createDiv();
    const second = root.createDiv();
    const removeFirst = mountWindowFeedback(html(first), html(root));
    const removeSecond = mountWindowFeedback(html(second), html(root));
    const host = body.getElementsByClassName("inkbook-feedback-host").item(0);

    expect(root.children).toHaveLength(0);
    expect(host?.parentElement).toBe(body);
    expect(host?.children).toHaveLength(2);
    expect(first.parentElement?.dataset).toEqual({
      inkbookScheme: "dark",
      inkbookMotion: "reduced",
    });
    removeFirst();
    expect(host?.children).toHaveLength(1);
    expect(host?.contains(second)).toBe(true);
    removeSecond();
    removeSecond();
    expect(body.getElementsByClassName("inkbook-feedback-host").length).toBe(0);
  });

  it("keeps presentation replacement, global feedback, and pop-out windows independent", () => {
    const body = new FakePresentationElement();
    const popoutBody = new FakePresentationElement();
    const root = presentation(body);
    const popout = presentation(popoutBody);
    const manager = new InkbookFeedbackManager();
    const ownerWindow = body.ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("Missing owner window.");
    manager.showInPresentation(html(root), request);
    manager.showInWindow(ownerWindow, request);
    manager.showInPresentation(html(popout), request);
    manager.showInPresentation(html(root), request);

    expect(root.children).toHaveLength(0);
    expect(popout.children).toHaveLength(0);
    expect(body.getElementsByClassName("inkbook-feedback-host").length).toBe(1);
    expect(body.getElementsByClassName("inkbook-feedback").length).toBe(2);
    expect(popoutBody.getElementsByClassName("inkbook-feedback").length).toBe(1);
    manager.closePresentation(html(root));
    expect(body.getElementsByClassName("inkbook-feedback").length).toBe(1);
    expect(popoutBody.getElementsByClassName("inkbook-feedback").length).toBe(1);
    manager.dispose();
    expect(body.getElementsByClassName("inkbook-feedback-host").length).toBe(0);
    expect(popoutBody.getElementsByClassName("inkbook-feedback-host").length).toBe(0);
  });
});
