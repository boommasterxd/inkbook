import { describe, expect, it, vi } from "vitest";

import { bindActiveSceneScrollOwner } from "../../../../src/obsidian/embeds/active-scene-scroll";
import type { BrowserScrollElement } from "../../../../src/obsidian/scrolling/index";

describe("active scene scroll ownership", () => {
  it("transfers navigation and scroll invalidation to the live owner", () => {
    const first = new EventTarget() as BrowserScrollElement;
    const second = new EventTarget() as BrowserScrollElement;
    const ownerWindow = Object.assign(new EventTarget(), {
      getComputedStyle: (owner: BrowserScrollElement) => ({
        paddingTop: owner === first ? "32px" : "16px",
      }),
    }) as unknown as Window;
    const properties = new Map<string, string>();
    const root = {
      style: { setProperty: (name: string, value: string) => properties.set(name, value) },
    } as unknown as HTMLElement;
    let liveOwner = first;
    const invalidate = vi.fn();
    const transfer = vi.fn();
    const binding = bindActiveSceneScrollOwner({
      initialOwner: first,
      invalidate,
      ownerWindow,
      provider: () => liveOwner,
      root,
      transfer,
    });

    expect(properties.get("--inkbook-toolbar-scrollport-padding")).toBe("32px");

    first.dispatchEvent(new Event("scroll"));
    expect(invalidate).toHaveBeenCalledOnce();
    liveOwner = second;
    expect(binding.current()).toBe(second);
    expect(transfer).toHaveBeenCalledWith(second);
    expect(properties.get("--inkbook-toolbar-scrollport-padding")).toBe("16px");
    first.dispatchEvent(new Event("scroll"));
    second.dispatchEvent(new Event("scroll"));
    expect(invalidate).toHaveBeenCalledTimes(2);

    binding.dispose();
    second.dispatchEvent(new Event("scroll"));
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
