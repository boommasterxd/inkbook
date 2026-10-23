import { describe, expect, it, vi } from "vitest";

import { OwnerWindowRegistry } from "../../../../src/obsidian/embeds/presentation/owner-window-registry";

describe("document owner-window leases", () => {
  it("requires the current presentation owner before a retained realm or fallback", () => {
    const registry = new OwnerWindowRegistry();
    const mounted = { closed: false } as Window;
    const retained = { closed: false } as Window;
    const fallback = { closed: false } as Window;
    const resolveFallback = vi.fn((): Window | undefined => fallback);
    const root = { ownerDocument: { defaultView: mounted } } as HTMLElement;
    const presentations = [{ attachment: { documentId: "ink.svg", root } }];
    registry.observe("ink.svg", retained);
    expect(registry.require("ink.svg", presentations, resolveFallback)).toBe(mounted);
    expect(resolveFallback).not.toHaveBeenCalled();
    expect(registry.require("ink.svg", [], resolveFallback)).toBe(retained);
    registry.clear();
    expect(registry.require("ink.svg", [], resolveFallback)).toBe(fallback);
    resolveFallback.mockReturnValue(undefined);
    expect(() => registry.require("ink.svg", [], resolveFallback)).toThrow("no owning window");
  });
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
