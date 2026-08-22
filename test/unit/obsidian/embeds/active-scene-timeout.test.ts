import { describe, expect, it, vi } from "vitest";

import { ActiveSceneTimeout } from "../../../../src/obsidian/embeds/active-scene-timeout";

describe("ActiveSceneTimeout", () => {
  it("forgets a normally completed UI timeout", async () => {
    let callback = (): void => undefined;
    const clearTimeout = vi.fn();
    const setTimeout = vi.fn((scheduled: () => void) => {
      callback = scheduled;
      return 7;
    });
    const ownerWindow = {
      clearTimeout,
      setTimeout,
    } as unknown as Window;
    const timeout = new ActiveSceneTimeout(ownerWindow);
    const completion = timeout.wait(240);

    callback();
    await completion;
    timeout.cancel();

    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 240);
    expect(clearTimeout).not.toHaveBeenCalled();
  });

  it("clears and settles a pending UI timeout on cancellation", async () => {
    const clearTimeout = vi.fn();
    const ownerWindow = { clearTimeout, setTimeout: vi.fn(() => 11) } as unknown as Window;
    const timeout = new ActiveSceneTimeout(ownerWindow);
    const completion = timeout.wait(240);

    timeout.cancel();
    await expect(completion).resolves.toBeUndefined();
    timeout.cancel();

    expect(clearTimeout).toHaveBeenCalledOnce();
    expect(clearTimeout).toHaveBeenCalledWith(11);
  });

  it("does not let a stale callback forget a replacement timeout with a reused handle", async () => {
    const callbacks: Array<() => void> = [];
    const clearTimeout = vi.fn();
    const ownerWindow = {
      clearTimeout,
      setTimeout: (callback: () => void) => {
        callbacks.push(callback);
        return 5;
      },
    } as unknown as Window;
    const timeout = new ActiveSceneTimeout(ownerWindow);
    const first = timeout.wait(240);
    timeout.cancel();
    await first;
    const second = timeout.wait(240);

    callbacks[0]?.();
    timeout.cancel();
    await second;

    expect(clearTimeout.mock.calls).toEqual([[5], [5]]);
  });
});
