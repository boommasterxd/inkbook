import { describe, expect, it, vi } from "vitest";

import { PresentationLifecycleRegistry } from "../../../../../src/obsidian/embeds/presentation/presentation-lifecycle-registry";

function root(): HTMLElement {
  return {} as HTMLElement;
}

describe("PresentationLifecycleRegistry", () => {
  it("replaces a root disposer and keeps the replacement after a stale release", () => {
    const registry = new PresentationLifecycleRegistry();
    const presentationRoot = root();
    const previous = vi.fn();
    const current = vi.fn();

    const releasePrevious = registry.register(presentationRoot, previous);
    const releaseCurrent = registry.register(presentationRoot, current);
    releasePrevious?.();

    expect(previous).toHaveBeenCalledOnce();
    registry.dispose(presentationRoot);
    releaseCurrent?.();
    registry.dispose(presentationRoot);
    expect(current).toHaveBeenCalledOnce();
  });

  it("disposes all roots once and rejects registrations after disposal", () => {
    const registry = new PresentationLifecycleRegistry();
    const firstRoot = root();
    const secondRoot = root();
    const first = vi.fn();
    const second = vi.fn();

    registry.register(firstRoot, first);
    registry.register(secondRoot, second);
    registry.disposeAll();
    registry.disposeAll();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(registry.register(root(), vi.fn())).toBeUndefined();
  });

  it("ignores disposal of an unknown root", () => {
    const registry = new PresentationLifecycleRegistry();

    expect(() => registry.dispose(root())).not.toThrow();
  });

  it("removes a root when its current release is called", () => {
    const registry = new PresentationLifecycleRegistry();
    const presentationRoot = root();
    const dispose = vi.fn();
    const release = registry.register(presentationRoot, dispose);

    release?.();
    registry.dispose(presentationRoot);

    expect(dispose).not.toHaveBeenCalled();
  });
});
