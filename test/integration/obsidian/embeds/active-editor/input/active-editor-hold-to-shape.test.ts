// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import { buildElementPathParts } from "../../../../../../src/domain/geometry/public";
import type { InkElementV1, PointV1 } from "../../../../../../src/domain/schema/public";
import { createInputState, reduceInput } from "../../../../../../src/editor/input";
import { GestureController } from "../../../../../../src/editor/gestures/public";
import { createDragElement } from "../../../../../../src/editor/tools/public";
import type { HoldToShapeSettingsV1 } from "../../../../../../src/domain/settings/types";
import { createBuiltInSettings } from "../../../../../../src/domain/settings/defaults";
import { CoalescedPointerInput } from "../../../../../../src/obsidian/embeds/active-editor/input/coalesced-input";
import * as recognition from "../../../../../../src/domain/recognition/stroke-recognition";
import { gestureControllerPorts } from "../../../../../fixtures/obsidian/active-editor";
import {
  createHoldFixture,
  HOLD_IDENTITY as IDENTITY,
  HOLD_SETTINGS as SETTINGS,
  holdPointer as pointer,
  advanceHold as hold,
  curvedArrowSamples,
  useHoldFixtures,
} from "../../../../../fixtures/obsidian/hold-to-shape";
import { ManualFrameScheduler } from "../../../../../fixtures/obsidian/manual-frame-scheduler";
import { fakeNode } from "../../../../../unit/rendering/scene/fakes";
import {
  CLOSED_VERTICES,
  quadraticSamples,
  sampledPath,
} from "../../../../../unit/domain/recognition/recognition-fixtures";

const LINE = sampledPath(
  [
    [10, 20],
    [210, 20],
  ],
  false,
);
const trackFixture = useHoldFixtures();

function setup(points = LINE, settings: HoldToShapeSettingsV1 = { ...SETTINGS }, paused = false) {
  return trackFixture(createHoldFixture({ points, settings, pausedRecognition: paused }));
}

function expectCancelledGesture(fixture: ReturnType<typeof setup>): void {
  expect(fixture.store.size).toBe(0);
  expect(fixture.history.commandCount).toBe(0);
  expect(fixture.ghost.nodes[0]?.attributes.get("d") ?? "").toBe("");
  expect(vi.getTimerCount()).toBe(0);
}

type RecognitionCase = "line" | "rectangle" | "curve" | "arrow";
type RecognizedElement = Extract<InkElementV1, { kind: "line" | "rectangle" | "arrow" }>;

function expectGhostPaint(ghost: ReturnType<typeof setup>["ghost"], kind: RecognitionCase): void {
  expect(ghost.nodes[0]?.attributes.get("stroke-opacity")).toBe("0.15");
  expect(ghost.nodes[0]?.attributes.get("stroke")).toBe("#22C55EFF");
  expect(ghost.nodes[0]?.attributes.get("stroke-width")).toBe("8");
  if (kind === "rectangle") expect(ghost.nodes[0]?.attributes.get("fill")).toBe("none");
  if (kind === "arrow") {
    expect(ghost.nodes[1]?.attributes.get("fill")).toBe("#22C55EFF");
    expect(ghost.nodes[1]?.attributes.get("fill-opacity")).toBe("0.15");
    expect(ghost.nodes[1]?.attributes.get("stroke")).toBe("none");
  }
}

function expectNativeElement(
  fixture: ReturnType<typeof setup>,
  kind: RecognitionCase,
): RecognizedElement {
  const element = fixture.store.get(IDENTITY.id)!.element;
  if (element.kind !== "line" && element.kind !== "rectangle" && element.kind !== "arrow")
    throw new Error("Expected native shape geometry.");
  expect(element.kind).toBe(kind === "curve" ? "line" : kind);
  const native = createDragElement({
    identity: IDENTITY,
    defaults: fixture.defaults,
    tool: element.kind,
    start: { x: 0, y: 0 },
    end: { x: 200, y: 100 },
  });
  expect(element.style.outlineStyle).toBe(
    "outlineStyle" in native.style ? native.style.outlineStyle : undefined,
  );
  if (element.kind === "line") expect(element.bend === null).toBe(kind !== "curve");
  expect(element.style).toMatchObject({
    outlineColor: fixture.defaults.pen.color,
    outlineOpacity: 0.5,
    outlineStyle: "dashed",
    outlineWidth: 8,
  });
  if (element.kind === "rectangle") expect(element.style.fillColor).toBeNull();
  if (element.kind === "arrow") {
    expect(element).toMatchObject({ startNode: "circle", endNode: "triangle" });
    expect(element.bend?.y).toBeCloseTo(-50, -1);
  }
  return element;
}

function expectCommittedPaint(
  fixture: ReturnType<typeof setup>,
  element: RecognizedElement,
  ghostPath: string | undefined,
): void {
  const canonical = buildElementPathParts(element);
  expect(canonical.map((part) => part.d)).toEqual(expect.arrayContaining([ghostPath]));
  if (element.kind !== "arrow") return;
  expect(canonical.map((part) => part.paint)).toEqual(["stroke", "fill"]);
  const content = fakeNode(fixture.renderer.svg).nodes[1]!.nodes[4]!;
  const filledNode = content.nodes.flatMap((node) =>
    node.tagName === "g" ? node.nodes : [node],
  )[1]!;
  expect(filledNode.attributes.get("d")).toBe(canonical[1]?.d);
  expect(filledNode.attributes.get("fill")).toBe("#22C55EFF");
  expect(filledNode.attributes.get("fill-opacity")).toBe("0.5");
}

describe("draw hold-to-shape integration", () => {
  it("retains raw ink without timers or recognition when the pen Style toggle is off", () => {
    const recognize = vi.spyOn(recognition, "recognizeStrokeSteps");
    try {
      const fixture = trackFixture(createHoldFixture({ points: LINE, holdEnabled: false }));
      expect(vi.getTimerCount()).toBe(0);
      hold(fixture, 2000);
      expect(recognize).not.toHaveBeenCalled();
      expect(fixture.ghost.nodes[0]?.attributes.get("d") ?? "").toBe("");
      expect(fixture.preview.commit()).toBe(true);
      expect(fixture.store.get(IDENTITY.id)?.element.kind).toBe("stroke");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      recognize.mockRestore();
    }
  });

  it.each([
    ["line", LINE],
    ["rectangle", sampledPath(CLOSED_VERTICES.rectangle)],
    ["curve", quadraticSamples({ x: 80, y: 120 })],
    ["arrow", curvedArrowSamples()],
  ] as const)(
    "commits a real recognized %s through normal store/history/rendering",
    (kind, points) => {
      const fixture = setup(points);
      const { store, history, preview, ghost, raw, renderer, scheduler } = fixture;
      hold(fixture, 599);
      expect(store.size).toBe(0);
      expect(ghost.nodes[0]?.attributes.get("d") ?? "").toBe("");
      const rawPaths = raw.nodes.flatMap((node) => (node.nodes.length === 0 ? [node] : node.nodes));
      expect(rawPaths.some((node) => (node.attributes.get("d")?.length ?? 0) > 0)).toBe(true);
      hold(fixture, 1);
      expect(ghost.attributes.get("pointer-events")).toBe("none");
      expect(ghost.parentNode?.nodes.indexOf(ghost)).toBeLessThan(
        raw.parentNode!.nodes.indexOf(raw),
      );
      expectGhostPaint(ghost, kind);
      expect(raw.nodes.length).toBeGreaterThan(0);
      expect(store.size).toBe(0);
      const ghostPath = ghost.nodes[0]?.attributes.get("d");
      expect(preview.commit()).toBe(true);
      scheduler.runAll();
      const element = expectNativeElement(fixture, kind);
      expect(store.size).toBe(1);
      expect(history.commandCount).toBe(1);
      expect(renderer.mountedIds("content")).toEqual([IDENTITY.id]);
      expectCommittedPaint(fixture, element, ghostPath);
      expect(history.undo()).toBe(true);
      scheduler.runAll();
      expect(store.size).toBe(0);
      expect(history.canUndo).toBe(false);
      expect(history.redo()).toBe(true);
      scheduler.runAll();
      expect(store.get(IDENTITY.id)?.element).toEqual(element);
      expect(store.size).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe("raw hold movement", () => {
  it("releases before the deadline as unchanged raw ink with one history command", () => {
    const fixture = setup();
    hold(fixture, 599);
    expect(fixture.preview.commit()).toBe(true);
    hold(fixture, 1000);
    expect(fixture.store.get(IDENTITY.id)?.element.kind).toBe("stroke");
    expect(fixture.history.commandCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("allows the built-in 20-pixel jitter but cancels out-and-back movement before its frame", () => {
    const line = sampledPath(
      [
        [10, 20],
        [1211, 20],
      ],
      false,
    );
    const fixture = setup(line, createBuiltInSettings().holdToShape);
    hold(fixture, 399);
    expect(fixture.ghost.nodes[0]?.attributes.get("d") ?? "").toBe("");
    hold(fixture, 1);
    fixture.preview.observeInputSamples([
      { x: 1219, y: 20 },
      { x: 1231, y: 20 },
    ]);
    hold(fixture, 100);
    expect(fixture.ghost.nodes[0]?.attributes.get("d")).not.toBe("");
    const frame = new ManualFrameScheduler();
    let wrapped: ReturnType<CoalescedPointerInput["wrap"]>;
    const input = new CoalescedPointerInput({
      frameScheduler: frame,
      now: () => Date.now(),
      dispatchMove: (sample) => wrapped.update(sample),
      project: (event) => pointer(event.clientX, event.clientY),
    });
    wrapped = input.wrap(fixture.preview);
    const event = (point: PointV1, timeStamp: number) =>
      ({
        ...point,
        clientX: point.x,
        clientY: point.y,
        pointerId: 1,
        timeStamp,
      }) as PointerEvent;
    const terminal = event({ x: 1211, y: 20 }, 1001);
    Object.assign(terminal, {
      getCoalescedEvents: () => [event({ x: 1232, y: 20 }, 1000), terminal],
    });
    expect(input.dispatch(terminal)).toBe(true);
    expect(frame.pendingCount).toBe(1);
    fixture.scheduler.runAll();
    expect(fixture.ghost.nodes[0]?.attributes.get("d") ?? "").toBe("");
    expect(fixture.store.size).toBe(0);
    frame.runNext();
    hold(fixture, 399);
    expect(fixture.ghost.nodes[0]?.attributes.get("d") ?? "").toBe("");
    hold(fixture, 1);
    expect(fixture.ghost.nodes[0]?.attributes.get("d")).not.toBe("");
    wrapped.revert();
    fixture.scheduler.runAll();
    expect(fixture.store.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("hold session cancellation and settings", () => {
  it.each(["cancel", "stale-owner"] as const)(
    "rejects delayed recognition after %s",
    async (reason) => {
      const fixture = setup(LINE, { ...SETTINGS }, true);
      hold(fixture);
      if (reason === "stale-owner") fixture.invalidate();
      else fixture.preview.revert();
      fixture.admission.resume();
      await Promise.resolve();
      fixture.scheduler.runAll();
      expectCancelledGesture(fixture);
    },
  );

  it("routes lost pointer capture through the input reducer and controller without committing the ghost", () => {
    const fixture = setup();
    const controller = new GestureController(gestureControllerPorts(() => fixture.preview));
    const down = reduceInput(createInputState(), {
      type: "pointer-down",
      ...pointer(10, 20),
      button: 0,
      buttons: 1,
      controlOrMeta: false,
      shift: false,
      isPlatformContextClick: false,
    });
    controller.apply(down);
    hold(fixture);
    expect(fixture.ghost.nodes[0]?.attributes.get("d")).not.toBe("");
    controller.apply(reduceInput(down.state, { type: "lost-pointer-capture", pointerId: 1 }));
    hold(fixture, 1000);
    expectCancelledGesture(fixture);
  });

  it("snapshots the enabled setting for the current gesture", () => {
    const settings = { ...SETTINGS };
    const fixture = setup(LINE, settings);
    settings.enabled = false;
    hold(fixture);
    fixture.preview.commit();
    expect(fixture.store.get(IDENTITY.id)?.element.kind).toBe("line");
    const disabled = setup(LINE, { ...SETTINGS, enabled: false });
    hold(disabled, 2000);
    disabled.preview.commit();
    expect(disabled.store.get(IDENTITY.id)?.element.kind).toBe("stroke");
    expect(vi.getTimerCount()).toBe(0);
  });
});
