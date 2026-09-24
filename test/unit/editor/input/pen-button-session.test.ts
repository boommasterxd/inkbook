import { describe, expect, it } from "vitest";

import { PenButtonSession } from "../../../../src/editor/input/pen-button-session";

function penEvent(buttons: number, timeStamp = 0) {
  return { pointerId: 1, pointerType: "pen", button: -1, buttons, timeStamp };
}

describe("pen button session", () => {
  it.each([
    [2, "side-button"],
    [4, "side-button"],
    [32, "eraser"],
  ] as const)("holds button mask %s until a contact release", (buttons, role) => {
    const session = new PenButtonSession();
    expect(session.update(penEvent(buttons), "down")).toBe(role);
    expect(session.pointerId).toBe(1);
    expect(session.update(penEvent(buttons | 1, 10), "move")).toBe(role);
    expect(session.update({ ...penEvent(1, 20), button: 2 }, "move")).toBe("normal");
    expect(session.pendingReleaseAt).toBeUndefined();
  });

  it("keeps one fixed deadline for repeated hover events and clears it at expiry", () => {
    const session = new PenButtonSession();
    session.update(penEvent(4), "move");
    expect(session.update(penEvent(0, 20), "up")).toBe("side-button");
    expect(session.pendingReleaseAt).toBe(320);
    session.update(penEvent(0, 200), "move");
    expect(session.pendingReleaseAt).toBe(320);
    session.expire(319);
    expect(session.role).toBe("side-button");
    session.expire(320);
    expect(session.role).toBe("normal");
    expect(session.pointerId).toBeUndefined();
    expect(session.pendingReleaseAt).toBeUndefined();
  });

  it("retains the role when contact follows a synthetic release within the grace period", () => {
    const session = new PenButtonSession();
    session.update(penEvent(4), "down");
    session.update(penEvent(0, 10), "up");
    expect(session.update(penEvent(1, 309), "down")).toBe("side-button");
    expect(session.pendingReleaseAt).toBeUndefined();
    session.expire(500);
    expect(session.update(penEvent(1, 600), "move")).toBe("side-button");
    session.update(penEvent(0, 700), "up");
    expect(session.pendingReleaseAt).toBe(1000);
    session.expire(1000);
    expect(session.role).toBe("normal");
  });

  it("accepts pressure-only contact and resumes reliable edges after a fresh button signal", () => {
    const session = new PenButtonSession();
    session.update(penEvent(2), "move");
    session.update(penEvent(0, 10), "up");
    expect(session.update({ ...penEvent(0, 20), pressure: 0.5 }, "move")).toBe("side-button");
    expect(session.pendingReleaseAt).toBeUndefined();
    session.update(penEvent(3, 30), "move");
    expect(session.update(penEvent(1, 40), "move")).toBe("normal");
  });

  it("does not retain the role when contact starts at the expired deadline", () => {
    const session = new PenButtonSession();
    session.update(penEvent(2), "down");
    session.update(penEvent(0, 10), "up");
    expect(session.update(penEvent(1, 310), "down")).toBe("normal");
  });

  it("cancels pending release on a repeated press and tracks a changed pen role", () => {
    const session = new PenButtonSession();
    session.update(penEvent(2), "down");
    session.update(penEvent(0, 10), "up");
    expect(session.update(penEvent(32, 20), "down")).toBe("eraser");
    expect(session.pendingReleaseAt).toBeUndefined();
    session.expire(1000);
    expect(session.role).toBe("eraser");
  });
});

describe("pen button session ownership", () => {
  it("does not inherit a held button from another pen identity", () => {
    const session = new PenButtonSession();
    session.update(penEvent(4), "down");
    session.update(penEvent(0, 10), "up");
    expect(session.update({ ...penEvent(1, 20), pointerId: 2 }, "down")).toBe("normal");
    expect(session.pointerId).toBe(2);
    expect(session.pendingReleaseAt).toBeUndefined();
  });

  it.each(["mouse", "touch"])("ignores interleaved %s events", (pointerType) => {
    const session = new PenButtonSession();
    session.update(penEvent(4), "down");
    expect(session.update({ ...penEvent(1, 10), pointerType, pointerId: 2 }, "down")).toBe(
      "normal",
    );
    expect(session.role).toBe("side-button");
    expect(session.pointerId).toBe(1);
  });

  it("does not treat a release button ordinal as a new press", () => {
    const session = new PenButtonSession();
    expect(session.update({ ...penEvent(8), button: 2 }, "up")).toBe("normal");
    expect(session.pendingReleaseAt).toBeUndefined();
  });

  it("clears every state on cancellation and allows a fresh contact", () => {
    const session = new PenButtonSession();
    expect(session.role).toBe("normal");
    expect(session.pointerId).toBeUndefined();
    session.update(penEvent(4), "down");
    session.update(penEvent(0, 10), "up");
    session.reset();
    expect(session.role).toBe("normal");
    expect(session.pointerId).toBeUndefined();
    expect(session.pendingReleaseAt).toBeUndefined();
    expect(session.update(penEvent(1, 20), "down")).toBe("normal");
  });
});
