import { describe, expect, it } from "vitest";

import {
  PenScrollGuard,
  PresentationScrollLifecycle,
  resolveScrollOwner,
  SCROLLBAR_STABILITY_CLASS,
  ScrollbarLeaseRegistry,
} from "../../../../src/obsidian/scrolling";
import {
  createFakePorts,
  FakeFrameScheduler,
  FakeScrollElement,
} from "../../../unit/obsidian/scrolling/fakes";

describe("native scroll lifecycle", () => {
  it("shares stable ownership, transfers a live presentation, and leaves pen input style-neutral", () => {
    const firstOwner = new FakeScrollElement("main-window-owner");
    firstOwner.overflowY = "auto";
    firstOwner.scrollHeight = 500;
    firstOwner.scrollTop = 40;
    const secondOwner = new FakeScrollElement("pop-out-owner");
    secondOwner.overflowY = "scroll";
    secondOwner.scrollHeight = 600;
    const firstEmbed = new FakeScrollElement("reading-embed");
    const secondEmbed = new FakeScrollElement("live-preview-embed");
    firstEmbed.parent = firstOwner;
    secondEmbed.parent = firstOwner;
    const ports = createFakePorts(null);
    const scheduler = new FakeFrameScheduler();
    const leases = new ScrollbarLeaseRegistry(ports.classes);
    const measuredOwners: string[] = [];
    const createLifecycle = (embed: FakeScrollElement) =>
      new PresentationScrollLifecycle({
        leases,
        measurement: {
          apply: (ownerName: string) => measuredOwners.push(ownerName),
          read: (owner) => owner.name,
        },
        resolveOwner: () => resolveScrollOwner(embed, ports.document, ports.metrics),
        scheduler,
      });
    const reading = createLifecycle(firstEmbed);
    const livePreview = createLifecycle(secondEmbed);

    reading.mount();
    livePreview.mount();
    expect(leases.count(firstOwner)).toBe(2);
    expect(measuredOwners).toEqual([]);
    scheduler.runNext();
    scheduler.runNext();
    expect(measuredOwners).toEqual(["main-window-owner", "main-window-owner"]);

    const styleBeforePen = new Set(firstOwner.classes);
    const guard = new PenScrollGuard({ ...ports, scheduler });
    guard.begin("pen", firstOwner);
    firstOwner.scrollTop = 125;
    firstOwner.emitScroll();
    firstOwner.emitScroll();
    expect(firstOwner.classes).toEqual(styleBeforePen);
    scheduler.runNext();
    expect(firstOwner.scrollTop).toBe(40);
    expect(firstOwner.classes).toEqual(styleBeforePen);
    guard.stop();

    secondEmbed.parent = secondOwner;
    livePreview.transferAfterLayoutChange();
    scheduler.runNext();
    expect(leases.count(firstOwner)).toBe(2);
    expect(leases.count(secondOwner)).toBe(1);
    scheduler.runNext();
    expect(leases.count(firstOwner)).toBe(1);
    expect(leases.count(secondOwner)).toBe(1);

    reading.unload();
    livePreview.unload();
    expect(firstOwner.classes).not.toContain(SCROLLBAR_STABILITY_CLASS);
    expect(secondOwner.classes).not.toContain(SCROLLBAR_STABILITY_CLASS);
    expect(firstOwner.listeners.size).toBe(0);
    expect(scheduler.pendingCount).toBe(0);
  });
});
