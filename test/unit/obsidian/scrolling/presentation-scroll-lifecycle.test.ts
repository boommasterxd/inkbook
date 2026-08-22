import { describe, expect, it } from "vitest";

import {
  PresentationScrollLifecycle,
  SCROLLBAR_STABILITY_CLASS,
  ScrollbarLeaseRegistry,
} from "../../../../src/obsidian/scrolling";
import { createFakePorts, FakeFrameScheduler, FakeScrollElement } from "./fakes";

function createLifecycle(initialOwner: FakeScrollElement) {
  const scheduler = new FakeFrameScheduler();
  const ports = createFakePorts(null);
  const leases = new ScrollbarLeaseRegistry(ports.classes);
  const applied: string[] = [];
  const reads: string[] = [];
  const transfers: string[] = [];
  let resolvedOwner: FakeScrollElement | null = initialOwner;
  const lifecycle = new PresentationScrollLifecycle({
    leases,
    measurement: {
      apply: (measurement: string) => applied.push(measurement),
      read: (owner) => {
        reads.push(owner.name);
        return `geometry:${owner.name}`;
      },
    },
    onOwnerTransferred: (owner, previousOwner) =>
      transfers.push(`${previousOwner.name}->${owner.name}`),
    resolveOwner: () => resolvedOwner,
    scheduler,
  });
  return {
    applied,
    leases,
    lifecycle,
    reads,
    scheduler,
    transfers,
    setOwner: (owner: FakeScrollElement | null) => {
      resolvedOwner = owner;
    },
  };
}

function startOwnerTransfer() {
  const oldOwner = new FakeScrollElement("old");
  const newOwner = new FakeScrollElement("new");
  const fixture = createLifecycle(oldOwner);
  fixture.lifecycle.mount();
  fixture.scheduler.runNext();
  fixture.setOwner(newOwner);
  fixture.lifecycle.transferAfterLayoutChange();
  fixture.scheduler.runNext();
  return { fixture, newOwner, oldOwner };
}

describe("PresentationScrollLifecycle", () => {
  it("acquires in a write-only phase and measures in the following frame", () => {
    const owner = new FakeScrollElement("owner");
    const fixture = createLifecycle(owner);

    expect(fixture.lifecycle.mount()).toBe(true);
    expect(owner.classes).toContain(SCROLLBAR_STABILITY_CLASS);
    expect(fixture.reads).toEqual([]);
    expect(fixture.applied).toEqual([]);

    fixture.scheduler.runNext();
    expect(fixture.reads).toEqual(["owner"]);
    expect(fixture.applied).toEqual(["geometry:owner"]);
  });

  it("transfers over two frames and releases the old owner after applying geometry", () => {
    const { fixture, newOwner, oldOwner } = startOwnerTransfer();
    expect(fixture.leases.count(oldOwner)).toBe(1);
    expect(fixture.leases.count(newOwner)).toBe(1);
    expect(fixture.reads).toEqual(["old"]);

    fixture.scheduler.runNext();
    expect(fixture.applied).toEqual(["geometry:old", "geometry:new"]);
    expect(fixture.leases.count(oldOwner)).toBe(0);
    expect(fixture.leases.count(newOwner)).toBe(1);
    expect(fixture.lifecycle.owner).toBe(newOwner);
    expect(fixture.transfers).toEqual(["old->new"]);
  });

  it("releases immediately on unload during either transfer frame", () => {
    const { fixture, newOwner, oldOwner } = startOwnerTransfer();

    fixture.lifecycle.unload();
    expect(fixture.scheduler.pendingCount).toBe(0);
    expect(fixture.leases.count(oldOwner)).toBe(0);
    expect(fixture.leases.count(newOwner)).toBe(0);
    expect(fixture.lifecycle.owner).toBeNull();
  });

  it("acquires a fresh lease after a true unload and remount", () => {
    const owner = new FakeScrollElement("owner");
    const fixture = createLifecycle(owner);
    fixture.lifecycle.mount();
    fixture.lifecycle.unload();
    expect(fixture.leases.count(owner)).toBe(0);

    expect(fixture.lifecycle.mount()).toBe(true);
    expect(fixture.leases.count(owner)).toBe(1);
    fixture.scheduler.runNext();
    fixture.lifecycle.unload();
  });

  it("does nothing for an unresolved owner or an unchanged live owner", () => {
    const owner = new FakeScrollElement("owner");
    const fixture = createLifecycle(owner);
    fixture.setOwner(null);
    expect(fixture.lifecycle.mount()).toBe(false);
    fixture.setOwner(owner);
    fixture.lifecycle.mount();
    fixture.scheduler.runNext();

    fixture.lifecycle.transferAfterLayoutChange();
    fixture.scheduler.runNext();
    expect(fixture.scheduler.pendingCount).toBe(0);
    expect(fixture.leases.count(owner)).toBe(1);
  });
});
