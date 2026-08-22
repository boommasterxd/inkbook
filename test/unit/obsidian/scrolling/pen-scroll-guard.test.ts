import { describe, expect, it } from "vitest";

import { PenScrollGuard } from "../../../../src/obsidian/scrolling";
import { createFakePorts, FakeFrameScheduler, FakeScrollElement } from "./fakes";

describe("PenScrollGuard", () => {
  it("ignores non-pen pointers", () => {
    const owner = new FakeScrollElement("owner");
    const scheduler = new FakeFrameScheduler();
    const ports = createFakePorts(null);
    const guard = new PenScrollGuard({ ...ports, scheduler });

    expect(guard.begin("touch", owner)).toBe(false);
    expect(guard.active).toBe(false);
    expect(owner.listeners.size).toBe(0);
  });

  it("coalesces scroll events and restores the pointer-down position", () => {
    const owner = new FakeScrollElement("owner");
    owner.scrollTop = 75;
    const scheduler = new FakeFrameScheduler();
    const ports = createFakePorts(null);
    const guard = new PenScrollGuard({ ...ports, scheduler });
    guard.begin("pen", owner);

    owner.scrollTop = 90;
    owner.emitScroll();
    owner.scrollTop = 110;
    owner.emitScroll();
    expect(scheduler.pendingCount).toBe(1);

    scheduler.runNext();
    expect(owner.scrollTop).toBe(75);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("cancels pending restoration and releases references on every stop", () => {
    const owner = new FakeScrollElement("owner");
    owner.scrollTop = 20;
    const scheduler = new FakeFrameScheduler();
    const ports = createFakePorts(null);
    const guard = new PenScrollGuard({ ...ports, scheduler });
    guard.begin("pen", owner);
    owner.scrollTop = 30;
    owner.emitScroll();

    guard.stop();
    guard.stop();
    expect(guard.active).toBe(false);
    expect(owner.listeners.size).toBe(0);
    expect(scheduler.pendingCount).toBe(0);
    expect(owner.scrollTop).toBe(20);
  });

  it("restores an unreported host scroll before release or cancellation completes", () => {
    const owner = new FakeScrollElement("owner");
    owner.scrollTop = 40;
    const scheduler = new FakeFrameScheduler();
    const ports = createFakePorts(null);
    const guard = new PenScrollGuard({ ...ports, scheduler });
    guard.begin("pen", owner);

    owner.scrollTop = 65;
    guard.stop();

    expect(owner.scrollTop).toBe(40);
    expect(owner.listeners.size).toBe(0);
  });

  it("replaces an active gesture without retaining its old owner", () => {
    const first = new FakeScrollElement("first");
    const second = new FakeScrollElement("second");
    const scheduler = new FakeFrameScheduler();
    const ports = createFakePorts(null);
    const guard = new PenScrollGuard({ ...ports, scheduler });
    guard.begin("pen", first);
    guard.begin("pen", second);

    expect(first.listeners.size).toBe(0);
    expect(second.listeners.size).toBe(1);
    guard.stop();
  });
});
