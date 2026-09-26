import { describe, expect, it, vi } from "vitest";

import { ElementStore } from "../../../../src/domain/store/public";
import { SelectionHandleSession } from "../../../../src/editor/selection/handle-session";
import { stroke } from "../../domain/schema/fixtures";

describe("affine freehand resize scheduling", () => {
  it.each([false, true])(
    "never visits short stroke samples during pointer updates, pressure=%s",
    (pressureEnabled) => {
      const source = stroke();
      let reads = 0;
      const points = new Proxy(source.points, {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/u.test(property)) reads += 1;
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
      const element = { ...source, points, style: { ...source.style, pressureEnabled } };
      const store = new ElementStore([element]);
      const planReplacements = vi.spyOn(store, "planReplacements");
      const session = new SelectionHandleSession({
        action: { anchor: { x: 98, y: 98 }, kind: "scale", position: "bottom-right", rotation: 0 },
        elements: [element],
        planner: store,
        startPointer: { x: 122, y: 122 },
      });
      reads = 0;
      for (let delta = 1; delta <= 20; delta += 1)
        session.update({ x: 122 + delta, y: 122 + delta });
      expect(reads).toBe(0);
      expect(planReplacements).not.toHaveBeenCalled();
      expect(store.get(element.id)?.element).toMatchObject({ points: source.points });
      expect(session.prepareCommit().status).toBe("ready");
      expect(reads).toBeGreaterThan(0);
      expect(planReplacements).toHaveBeenCalledOnce();
    },
  );

  it("keeps rejected stroke replacements out of the store", async () => {
    const element = stroke();
    const store = new ElementStore([element]);
    const planReplacements = vi.spyOn(store, "planReplacements").mockReturnValue(null);
    vi.spyOn(store, "planReplacementsTimeSliced").mockResolvedValue(null);
    const session = createSession(store);
    session.update({ x: 160, y: 160 });
    expect(planReplacements).not.toHaveBeenCalled();
    expect(session.prepareCommit()).toEqual({ status: "noop" });
    await expect(
      session.prepareCommitTimeSliced({
        shouldYield: () => false,
        yieldControl: async () => undefined,
      }),
    ).resolves.toMatchObject({ status: "ready" });
    expect(store.get(element.id)?.element).toEqual(element);
  });

  it("keeps invalid geometry as a no-op and propagates unexpected planner errors", () => {
    const element = stroke();
    const store = new ElementStore([element]);
    const plan = vi.spyOn(store, "planReplacements").mockImplementation(() => {
      throw new RangeError("Invalid replacement");
    });
    const session = createSession(store);
    session.update({ x: 160, y: 160 });
    expect(plan).not.toHaveBeenCalled();
    expect(session.prepareCommit()).toEqual({ status: "noop" });
    plan.mockImplementation(() => {
      throw new Error("Unexpected planner failure");
    });
    expect(() => session.prepareCommit()).toThrow("Unexpected planner failure");
    expect(store.get(element.id)?.element).toEqual(element);
  });
});

function createSession(store: ElementStore): SelectionHandleSession {
  return new SelectionHandleSession({
    action: { anchor: { x: 98, y: 98 }, kind: "scale", position: "bottom-right", rotation: 0 },
    elements: [stroke()],
    planner: store,
    startPointer: { x: 122, y: 122 },
  });
}
