import { describe, expect, it } from "vitest";

import { OwnerWindowRegistry } from "../../../../src/obsidian/embeds/owner-window-registry";

describe("document owner-window leases", () => {
  it("retains a detached session owner until the session is released", () => {
    const registry = new OwnerWindowRegistry();
    const detachedOwner = { closed: false } as Window;
    const otherOwner = { closed: false } as Window;
    registry.observe("drawings/detached.svg", detachedOwner);
    registry.observe("drawings/other.svg", otherOwner);

    registry.prune(new Set(["drawings/detached.svg"]));

    expect(registry.resolve("drawings/detached.svg")).toBe(detachedOwner);
    expect(registry.resolve("drawings/other.svg")).toBeUndefined();
    registry.prune(new Set());
    expect(registry.resolve("drawings/detached.svg")).toBeUndefined();
  });

  it("ignores a detached document that never had a usable owner window", () => {
    const registry = new OwnerWindowRegistry();
    registry.observe("drawings/page.svg", null);
    expect(registry.resolve("drawings/page.svg")).toBeUndefined();
  });

  it("drops a window as soon as its realm closes", () => {
    const registry = new OwnerWindowRegistry();
    const owner = { closed: false } as Window;
    registry.observe("drawings/page.svg", owner);
    Object.defineProperty(owner, "closed", { value: true });

    expect(registry.resolve("drawings/page.svg")).toBeUndefined();
  });

  it("rejects a window whose document no longer points at that realm", () => {
    const registry = new OwnerWindowRegistry();
    const owner = { closed: false } as Window;
    Object.defineProperty(owner, "document", { value: { defaultView: null } });

    registry.observe("drawings/page.svg", owner);

    expect(registry.resolve("drawings/page.svg")).toBeUndefined();
  });
});
