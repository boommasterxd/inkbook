import { describe, expect, it, vi } from "vitest";

import { DocumentSaveStatusSource } from "../../../../src/obsidian/embeds/document-save-status";
import type { AutosaveStatus } from "../../../../src/persistence/saving/autosave/types";
import type { DocumentSaveStatus } from "../../../../src/editor/session/session-port";

describe("document save status source", () => {
  it.each<AutosaveStatus>([
    "conflict",
    "executor-failed",
    "retryable-error",
    "verification-required",
  ])("keeps %s actionable even without a revision mismatch", (status) => {
    const source = new DocumentSaveStatusSource();
    source.update({ dirty: false, status });
    expect(source.current()).toBe("failed");
  });

  it("publishes only meaningful transitions through pending, saving, and exact confirmation", () => {
    const source = new DocumentSaveStatusSource();
    const statuses: DocumentSaveStatus[] = [];
    const changes = vi.fn(() => statuses.push(source.current()));
    source.subscribe(changes);
    source.update({ dirty: false, status: "clean" });
    expect(source.current()).toBe("saved");
    expect(changes).not.toHaveBeenCalled();

    source.update({ dirty: true, status: "debouncing" });
    source.update({ dirty: true, status: "waiting-for-gesture" });
    expect(source.current()).toBe("pending");
    expect(changes).toHaveBeenCalledOnce();
    source.update({ dirty: true, status: "saving" });
    source.update({ dirty: true, status: "saving" });
    expect(source.current()).toBe("saving");
    source.update({ dirty: true, status: "clean" });
    expect(source.current()).toBe("pending");
    source.update({ dirty: false, status: "clean" });
    expect(statuses).toEqual(["pending", "saving", "pending", "saved"]);
  });

  it("releases subscriptions and ignores terminal notifications", () => {
    const source = new DocumentSaveStatusSource();
    const removed = vi.fn();
    const listener = vi.fn();
    source.subscribe(removed)();
    source.subscribe(listener);
    source.update({ dirty: true, status: "debouncing" });
    expect(removed).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledOnce();
    source.dispose();
    source.dispose();
    source.subscribe(removed);
    source.update({ dirty: true, status: "executor-failed" });
    expect(source.current()).toBe("pending");
    expect(removed).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledOnce();
  });
});
