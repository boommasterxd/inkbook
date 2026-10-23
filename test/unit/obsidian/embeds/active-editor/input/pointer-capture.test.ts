import { describe, expect, it, vi } from "vitest";

import { ActivePointerCaptureOwner } from "../../../../../../src/obsidian/embeds/active-editor/input/pointer-capture";

describe("ActivePointerCaptureOwner", () => {
  it("releases every capture exactly once during disable or dispose cleanup", () => {
    const captured = new Set<number>();
    const surface = {
      hasPointerCapture: vi.fn((pointerId: number) => captured.has(pointerId)),
      releasePointerCapture: vi.fn((pointerId: number) => captured.delete(pointerId)),
      setPointerCapture: vi.fn((pointerId: number) => captured.add(pointerId)),
    };
    const owner = new ActivePointerCaptureOwner(surface);
    owner.capture(4);
    owner.capture(9);

    owner.releaseAll();
    owner.releaseAll();

    expect(surface.releasePointerCapture.mock.calls).toEqual([[4], [9]]);
    expect(captured.size).toBe(0);
  });

  it("forgets capture ownership after a native lost-capture notification", () => {
    const surface = {
      hasPointerCapture: vi.fn(() => false),
      releasePointerCapture: vi.fn(),
      setPointerCapture: vi.fn(),
    };
    const owner = new ActivePointerCaptureOwner(surface);
    owner.capture(7);
    owner.release(7);
    owner.releaseAll();

    expect(surface.releasePointerCapture).not.toHaveBeenCalled();
  });

  it("drops ownership before native release can synchronously notify listeners", () => {
    let owner: ActivePointerCaptureOwner;
    const captured = new Set<number>();
    const ownershipDuringRelease: boolean[] = [];
    const surface = {
      hasPointerCapture: vi.fn((pointerId: number) => captured.has(pointerId)),
      releasePointerCapture: vi.fn((pointerId: number) => {
        ownershipDuringRelease.push(owner.owns(pointerId));
        captured.delete(pointerId);
      }),
      setPointerCapture: vi.fn((pointerId: number) => captured.add(pointerId)),
    };
    owner = new ActivePointerCaptureOwner(surface);
    owner.capture(11);

    owner.release(11);

    expect(ownershipDuringRelease).toEqual([false]);
    expect(owner.owns(11)).toBe(false);
  });
});
