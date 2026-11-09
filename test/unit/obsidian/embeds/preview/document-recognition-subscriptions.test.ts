import { describe, expect, it, vi } from "vitest";

import { DocumentRecognitionSubscriptions } from "../../../../../src/obsidian/embeds/preview/document-recognition-subscriptions";

describe("document recognition subscriptions", () => {
  it("routes file notifications to matching presentations and shared note views", () => {
    const subscriptions = new DocumentRecognitionSubscriptions();
    const shared = vi.fn();
    const first = vi.fn();
    const second = vi.fn();
    subscriptions.subscribe(shared);
    const release = subscriptions.subscribe(first, "first.svg");
    subscriptions.subscribe(second, "second.svg");

    subscriptions.notify("first.svg");
    expect(shared).toHaveBeenCalledExactlyOnceWith("first.svg");
    expect(first).toHaveBeenCalledExactlyOnceWith("first.svg");
    expect(second).not.toHaveBeenCalled();
    release();
    release();
    subscriptions.notify("second.svg");
    subscriptions.notify("first.svg");
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledExactlyOnceWith("second.svg");
    expect(shared).toHaveBeenCalledTimes(3);
    subscriptions.clear();
  });

  it("isolates failed listeners across both subscription scopes", () => {
    const subscriptions = new DocumentRecognitionSubscriptions();
    const fail = () => {
      throw new Error("Presentation failed");
    };
    const shared = vi.fn();
    const matching = vi.fn();
    subscriptions.subscribe(fail);
    subscriptions.subscribe(shared);
    subscriptions.subscribe(fail, "drawing.svg");
    subscriptions.subscribe(matching, "drawing.svg");

    expect(() => subscriptions.notify("drawing.svg")).not.toThrow();
    expect(shared).toHaveBeenCalledExactlyOnceWith("drawing.svg");
    expect(matching).toHaveBeenCalledExactlyOnceWith("drawing.svg");
    subscriptions.clear();
  });

  it("clears retained listeners without allowing stale cleanup to remove a replacement", () => {
    const subscriptions = new DocumentRecognitionSubscriptions();
    const first = vi.fn();
    const replacement = vi.fn();
    const shared = vi.fn();
    const release = subscriptions.subscribe(first, "drawing.svg");
    subscriptions.subscribe(shared);
    subscriptions.clear();
    subscriptions.subscribe(replacement, "drawing.svg");
    release();

    subscriptions.notify("drawing.svg");
    expect(first).not.toHaveBeenCalled();
    expect(shared).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledExactlyOnceWith("drawing.svg");
    subscriptions.clear();
  });
});
