import { describe, expect, it, vi } from "vitest";

import { bindActiveSceneScrollOwner } from "../../../../src/obsidian/embeds/active-scene-scroll";
import type { BrowserScrollElement } from "../../../../src/obsidian/scrolling/index";

describe("active scene scroll ownership", () => {
  it("transfers navigation and scroll invalidation to the live owner", () => {
    const first = new EventTarget() as BrowserScrollElement;
    const second = new EventTarget() as BrowserScrollElement;
    const ownerWindow = new EventTarget() as Window;
    let liveOwner = first;
    const invalidate = vi.fn();
    const transfer = vi.fn();
    const binding = bindActiveSceneScrollOwner({
      initialOwner: first,
      invalidate,
      ownerWindow,
      provider: () => liveOwner,
      transfer,
    });

    first.dispatchEvent(new Event("scroll"));
    expect(invalidate).toHaveBeenCalledOnce();
    liveOwner = second;
    expect(binding.current()).toBe(second);
    expect(transfer).toHaveBeenCalledWith(second);
    first.dispatchEvent(new Event("scroll"));
    second.dispatchEvent(new Event("scroll"));
    expect(invalidate).toHaveBeenCalledTimes(2);

    binding.dispose();
    second.dispatchEvent(new Event("scroll"));
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});
