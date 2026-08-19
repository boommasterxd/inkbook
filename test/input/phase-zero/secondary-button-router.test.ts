/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact pointer coordinates exercise the inclusive product threshold. */
import { describe, expect, it } from "vitest";

import {
  SecondaryButtonRouter,
  type SecondaryPointerDown,
} from "../../../src/input/phase-zero";

const down = (
  hit:
    { kind: "native-markdown" } | { kind: "plugin-element"; elementId: string },
  overrides: Partial<{
    pointerId: number;
    clientX: number;
    clientY: number;
    button: number;
    zoomPercent: number;
    panRangeX: number;
    panRangeY: number;
  }> = {},
): SecondaryPointerDown => ({
  pointerId: 1,
  clientX: 10,
  clientY: 20,
  button: 2,
  hit,
  zoomPercent: 150,
  panRangeX: 100,
  panRangeY: 0,
  ...overrides,
});

// eslint-disable-next-line max-lines-per-function -- The state-machine scenarios form one cohesive contract suite.
describe("SecondaryButtonRouter", () => {
  it("preserves a stationary native context menu after pointer up", () => {
    const router = new SecondaryButtonRouter();
    expect(router.pointerDown(down({ kind: "native-markdown" }))).toMatchObject(
      {
        action: "none",
        preventDefault: false,
      },
    );
    router.pointerUp(1);
    expect(router.state).toBe("menu-awaiting-context");
    expect(router.contextMenu()).toMatchObject({
      action: "native-menu",
      preventDefault: false,
      stopPropagation: false,
      frozenHit: { kind: "native-markdown" },
    });
  });

  it("uses the frozen plugin hit and suppresses the native menu", () => {
    const router = new SecondaryButtonRouter();
    const hit = { kind: "plugin-element", elementId: "shape-1" } as const;
    router.pointerDown(down(hit));
    (hit as { elementId: string }).elementId = "changed-after-down";
    router.pointerUp(1);

    expect(router.contextMenu()).toEqual({
      action: "plugin-menu",
      preventDefault: true,
      stopPropagation: true,
      frozenHit: { kind: "plugin-element", elementId: "shape-1" },
    });
    expect(router.state).toBe("idle");
  });

  it.each([7.999, 8, 9])(
    "applies the inclusive pan threshold at %s pixels",
    (distance) => {
      const router = new SecondaryButtonRouter();
      router.pointerDown(down({ kind: "native-markdown" }));

      const result = router.pointerMove({
        pointerId: 1,
        clientX: 10 + distance,
        clientY: 20,
      });

      expect(result.action).toBe(distance < 8 ? "none" : "pan-started");
      expect(result.preventDefault).toBe(distance >= 8);
      expect(result.capturePointerId).toBe(distance < 8 ? undefined : 1);
    },
  );

  it.each([
    [100, 100, 100],
    [150, 0, 0],
  ])("never pans with ineligible zoom or ranges", (zoomPercent, x, y) => {
    const router = new SecondaryButtonRouter();
    router.pointerDown(
      down(
        { kind: "native-markdown" },
        { zoomPercent, panRangeX: x, panRangeY: y },
      ),
    );

    expect(
      router.pointerMove({ pointerId: 1, clientX: 100, clientY: 100 }),
    ).toMatchObject({ action: "none", preventDefault: false });
  });

  it("pans incrementally, suppresses menus, and ends without annotation effects", () => {
    const router = new SecondaryButtonRouter();
    router.pointerDown(down({ kind: "plugin-element", elementId: "shape-1" }));
    expect(
      router.pointerMove({ pointerId: 1, clientX: 18, clientY: 20 }),
    ).toMatchObject({
      action: "pan-started",
      panDeltaScreen: { x: 8, y: 0 },
    });
    expect(router.contextMenu().action).toBe("menu-suppressed");
    expect(
      router.pointerMove({ pointerId: 1, clientX: 20, clientY: 24 }),
    ).toMatchObject({
      action: "pan-updated",
      panDeltaScreen: { x: 2, y: 4 },
    });
    expect(router.pointerUp(1)).toMatchObject({
      action: "pan-ended",
      releasePointerId: 1,
    });
    expect(router.state).toBe("idle");
  });

  it("cleans pending and active state on cancellation and disposal", () => {
    const pending = new SecondaryButtonRouter();
    pending.pointerDown(down({ kind: "native-markdown" }));
    expect(pending.pointerCancel(1).action).toBe("none");
    expect(pending.contextMenu().action).toBe("none");

    const active = new SecondaryButtonRouter();
    active.pointerDown(down({ kind: "native-markdown" }));
    active.pointerMove({ pointerId: 1, clientX: 18, clientY: 20 });
    expect(active.dispose().releasePointerId).toBe(1);
    expect(active.dispose().action).toBe("none");
    expect(active.state).toBe("disposed");
  });

  it("ignores primary, malformed, and unrelated events", () => {
    const router = new SecondaryButtonRouter();
    expect(
      router.pointerDown(down({ kind: "native-markdown" }, { button: 0 }))
        .action,
    ).toBe("none");
    expect(
      router.pointerDown(down({ kind: "native-markdown" }, { panRangeX: -1 }))
        .action,
    ).toBe("none");
    expect(router.pointerUp(99).action).toBe("none");
  });

  it("does not replace an in-flight frozen snapshot", () => {
    const router = new SecondaryButtonRouter();
    router.pointerDown(down({ kind: "plugin-element", elementId: "first" }));
    router.pointerDown(
      down({ kind: "plugin-element", elementId: "second" }, { pointerId: 2 }),
    );
    expect(router.contextMenu().frozenHit).toEqual({
      kind: "plugin-element",
      elementId: "first",
    });
  });
});
