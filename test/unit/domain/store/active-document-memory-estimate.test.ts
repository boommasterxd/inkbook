import { describe, expect, it } from "vitest";

import { ElementStore } from "../../../../src/domain/store/public";

import { IDS, rectangle } from "./fixtures";

describe("active document store memory estimate", () => {
  it("tracks initial records and committed additions and removals incrementally", () => {
    const first = rectangle(IDS.target);
    const second = rectangle(IDS.other, 300, 100);
    const store = new ElementStore([first]);
    const initial = store.activeDocumentMemoryUsage().modelBytes;

    store.create(second);
    const expanded = store.activeDocumentMemoryUsage().modelBytes;
    store.remove([second.id]);

    expect(initial).toBeGreaterThan(0);
    expect(expanded).toBeGreaterThan(initial);
    expect(store.activeDocumentMemoryUsage().modelBytes).toBe(initial);
    expect(store.instrumentation.fullStoreScans).toBe(0);
  });
});
