import { expect, it, vi } from "vitest";
import { navigationCursorFixture } from "../../../../../fixtures/obsidian/navigation-cursor";
import { readActiveSceneLayout } from "../../../../../../src/obsidian/embeds/active-scene/active-scene-viewport";

it.each(["draw", "select"] as const)(
  "shares a fresh native-scroll snapshot with the %s cursor",
  (tool) => {
    const { h, events, container, owner, navigation } = navigationCursorFixture(tool, "mouse");
    h.read();
    h.measure.mockClear();
    h.window.getComputedStyle.mockClear();
    h.request.mockClear();
    events.length = 0;
    Object.assign(owner, { clientHeight: 800 });
    Object.assign(container, { style: { blockSize: "2000px" } });
    const root = {
      classList: { contains: (value: string) => value === "inkbook-active-transitioning" },
    } as unknown as HTMLElement;
    const snapshot = readActiveSceneLayout(container, owner, root);
    h.controller.adoptSceneLayout(snapshot.cursorLayout);
    const cursor = h.read(true);
    expect(h.measure).toHaveBeenCalledOnce();
    expect(h.window.getComputedStyle).toHaveBeenCalledOnce();
    expect(events.filter((event) => event === "owner-box")).toHaveLength(1);
    expect(snapshot.viewport.height).toBe(800);
    expect(snapshot.cursorLayout.containerBounds.height).toBe(400);
    expect(cursor.cursor?.clip?.bottom).toBe(430);
    expect(h.request).not.toHaveBeenCalled();
    h.bounds.top += 20;
    h.read(true);
    expect(h.measure).toHaveBeenCalledTimes(2);
    expect(h.controller.lastScreenPointer?.y).toBe(30);
    navigation.dispose();
    h.controller.dispose();
  },
);

it("skips proven unchanged clamped feedback but applies external geometry and reverse pan", () => {
  const { h, events, frames, navigation } = navigationCursorFixture("select", "mouse");
  navigation.restoreViewState({ cameraX: 0, zoom: 1 });
  events.length = 0;
  h.measure.mockClear();
  const input = h.controls.input;
  const wheel = (deltaY: number) =>
    navigation.updateWheel({ clientX: 120, clientY: 80, deltaMode: 0, deltaY, shiftKey: true });
  for (let index = 0; index < 20; index += 1) {
    wheel(-10);
    frames.runNext(index * 16);
  }
  expect(h.measure).toHaveBeenCalledTimes(20);
  expect(events.filter((event) => event === "camera-write")).toHaveLength(0);
  expect(h.controls.input).toBe(input);
  h.bounds.top += 5;
  wheel(-10);
  frames.runNext(400);
  expect(events.filter((event) => event === "camera-write")).toHaveLength(1);
  wheel(10);
  frames.runNext(416);
  expect(navigation.cameraX).toBe(-10);
  expect(events.filter((event) => event === "camera-write")).toHaveLength(2);
  navigation.dispose();
  h.controller.dispose();
});

it.each([
  ["draw", "mouse"],
  ["draw", "pen"],
  ["select", "mouse"],
  ["select", "pen"],
] as const)(
  "projects %s/%s cursor in the zoom frame without reading layout after writes",
  (tool, pointer) => {
    const { h, frames, events, navigation, frame, projected } = navigationCursorFixture(
      tool,
      pointer,
    );
    navigation.updateWheel({
      clientX: 120.25,
      clientY: 80.25,
      ctrlKey: true,
      deltaMode: 0,
      deltaY: -1,
    });
    frames.runNext(10);
    expect(events.slice(events.indexOf("height-write"))).toEqual([
      "height-write",
      "scroll-write",
      "scroll-read",
      "camera-write",
    ]);
    expect(h.measure).toHaveBeenCalledOnce();
    expect(h.window.getComputedStyle).toHaveBeenCalledOnce();
    expect(frame()?.cursor).toMatchObject({ x: 120, y: 80 });
    expect(projected()?.containerBounds.height).toBe(h.bounds.height);
    expect(projected()?.containerBounds.bottom).toBe(h.bounds.top + h.bounds.height);
    expect(h.controller.lastPagePointer?.y).toBeCloseTo((80 - h.bounds.top) / navigation.zoom, 10);
    expect(frame()?.cursor?.clip).toEqual({
      left: 20,
      right: 520,
      width: 500,
      top: Math.max(40, h.bounds.top),
      bottom: Math.min(340, h.bounds.top + h.bounds.height),
      height: Math.min(340, h.bounds.top + h.bounds.height) - Math.max(40, h.bounds.top),
    });
    h.bounds.top += 5;
    h.read(true);
    expect(h.measure).toHaveBeenCalledTimes(2);
    expect(h.controller.lastPagePointer?.y).toBeCloseTo((80 - h.bounds.top) / navigation.zoom, 10);
    navigation.dispose();
    h.controller.dispose();
  },
);

it("uses the native clamped scroll result when a large pan reaches the owner boundary", () => {
  const { h, frames, events, navigation, projected, owner } = navigationCursorFixture(
    "draw",
    "mouse",
  );
  navigation.scroll(-10000);
  frames.runNext(10);
  expect(owner.scrollTop).toBe(3700);
  expect(projected()?.containerBounds.top).toBe(h.bounds.top);
  expect(projected()?.containerBounds.height).toBe(h.bounds.height);
  expect(
    events
      .slice(events.indexOf("scroll-write"))
      .filter((event) => event === "box" || event === "style"),
  ).toEqual([]);
  navigation.dispose();
  h.controller.dispose();
});

it.each([0, 1, 2])(
  "normalizes horizontal mode %s only when page units need a host read",
  (deltaMode) => {
    const { h, navigation, owner } = navigationCursorFixture("draw", "mouse");
    Object.assign(h.window, { performance: { now: () => 1000 } });
    navigation.restoreViewState({ cameraX: 0, zoom: 2 });
    const readHeight = vi.fn(() => 300);
    Object.defineProperty(owner, "clientHeight", { get: readHeight });
    expect(
      navigation.updateWheel({
        clientX: 100,
        clientY: 100,
        deltaMode,
        deltaX: 4,
        deltaY: 0,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
    expect(readHeight).toHaveBeenCalledTimes(deltaMode === 2 ? 1 : 0);
    navigation.dispose();
    h.controller.dispose();
  },
);
