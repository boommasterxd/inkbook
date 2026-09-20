import { describe, expect, it, vi } from "vitest";
import { InteractiveWorkPriority } from "../../../../src/editor/session/interactive-work-priority";

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("session interactive priority", () => {
  it("keeps overlapping and newly reacquired leases ahead of waiting background work", async () => {
    const priority = new InteractiveWorkPriority();
    const first = priority.begin();
    const second = priority.begin();
    const work = vi.fn();
    const waiting = priority.waitForBackground().then(work);
    first();
    first();
    await tick();
    expect(work).not.toHaveBeenCalled();
    second();
    const third = priority.begin();
    await tick();
    expect(work).not.toHaveBeenCalled();
    third();
    await waiting;
    expect(work).toHaveBeenCalledOnce();
  });

  it.each(["resolve", "reject", "throw"])(
    "releases priority when work ends with %s",
    async (outcome) => {
      const priority = new InteractiveWorkPriority();
      const operation = () => {
        if (outcome === "throw") throw new Error("failure");
        return outcome === "reject" ? Promise.reject(new Error("failure")) : Promise.resolve(42);
      };
      if (outcome === "resolve") expect(await priority.run(operation)).toBe(42);
      else await expect(priority.run(operation)).rejects.toThrow("failure");
      await priority.waitForBackground();
    },
  );

  it("holds one input lease across repeated signals and overlapping history work", async () => {
    const priority = new InteractiveWorkPriority();
    priority.setInputActive(true);
    priority.setInputActive(true);
    const releaseHistory = priority.begin();
    const resumed = vi.fn();
    const waiting = priority.waitForBackground().then(resumed);
    priority.setInputActive(false);
    priority.setInputActive(false);
    await tick();
    expect(resumed).not.toHaveBeenCalled();
    releaseHistory();
    await waiting;
    expect(resumed).toHaveBeenCalledOnce();
    priority.setInputActive(true);
    const drain = priority.waitForBackground();
    priority.dispose();
    await drain;
    priority.setInputActive(false);
  });

  it("unblocks drain on disposal and ignores later releases and leases", async () => {
    const priority = new InteractiveWorkPriority();
    const release = priority.begin();
    const waiting = priority.waitForBackground();
    priority.dispose();
    await waiting;
    release();
    priority.begin()();
    priority.dispose();
    await priority.waitForBackground();
    expect(await priority.run(async () => 42)).toBe(42);
  });
});

it.each(["gesture", "navigation"] as const)(
  "keeps overlapping input sources active after %s ends",
  async (first) => {
    const priority = new InteractiveWorkPriority();
    priority.setInputActive(true, "gesture");
    priority.setInputActive(true, "navigation");
    priority.setInputActive(true, "navigation");
    const resumed = vi.fn();
    const waiting = priority.waitForBackground().then(resumed);
    priority.setInputActive(false, first);
    await tick();
    expect(priority.inputActive).toBe(true);
    expect(resumed).not.toHaveBeenCalled();
    priority.setInputActive(false, first === "gesture" ? "navigation" : "gesture");
    await waiting;
    expect(priority.inputActive).toBe(false);
    expect(resumed).toHaveBeenCalledOnce();
    priority.setInputActive(true, "navigation");
    const drain = priority.waitForBackground();
    priority.dispose();
    await drain;
    priority.setInputActive(true, "navigation");
    expect(priority.inputActive).toBe(false);
  },
);
