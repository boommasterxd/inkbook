import { describe, expect, it, vi } from "vitest";

import {
  SCROLLBAR_STABILITY_CLASS,
  ScrollbarLeaseRegistry,
} from "../../../../src/obsidian/scrolling";
import { FakeScrollElement } from "./fakes";

describe("ScrollbarLeaseRegistry", () => {
  it("shares the marker until the final lease is released", () => {
    const element = new FakeScrollElement("owner");
    const add = vi.fn((target: FakeScrollElement, className: string) =>
      target.classes.add(className),
    );
    const remove = vi.fn((target: FakeScrollElement, className: string) =>
      target.classes.delete(className),
    );
    const registry = new ScrollbarLeaseRegistry<FakeScrollElement>({ add, remove });

    const first = registry.acquire(element);
    const second = registry.acquire(element);
    expect(registry.count(element)).toBe(2);
    expect(add).toHaveBeenCalledOnce();
    expect(element.classes).toContain(SCROLLBAR_STABILITY_CLASS);

    first.release();
    first.release();
    expect(registry.count(element)).toBe(1);
    expect(remove).not.toHaveBeenCalled();

    second.release();
    expect(registry.count(element)).toBe(0);
    expect(remove).toHaveBeenCalledOnce();
    expect(element.classes).not.toContain(SCROLLBAR_STABILITY_CLASS);
  });

  it("tracks different owners independently", () => {
    const firstOwner = new FakeScrollElement("first");
    const secondOwner = new FakeScrollElement("second");
    const registry = new ScrollbarLeaseRegistry<FakeScrollElement>({
      add: (element, className) => element.classes.add(className),
      remove: (element, className) => element.classes.delete(className),
    });

    const first = registry.acquire(firstOwner);
    const second = registry.acquire(secondOwner);
    first.release();

    expect(registry.count(firstOwner)).toBe(0);
    expect(registry.count(secondOwner)).toBe(1);
    second.release();
  });
});
