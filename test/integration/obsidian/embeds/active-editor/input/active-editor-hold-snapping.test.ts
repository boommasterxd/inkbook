// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { buildElementPathParts } from "../../../../../../src/domain/geometry/public";
import type { PointV1 } from "../../../../../../src/domain/schema/public";
import { immediateWorkScheduler } from "../../../../../fixtures/obsidian/immediate-work-scheduler";
import {
  advanceHold,
  createHoldFixture,
  curvedArrowSamples,
  HOLD_IDENTITY,
  holdPointer,
  useHoldFixtures,
} from "../../../../../fixtures/obsidian/hold-to-shape";
import { sceneCreationSnapPorts } from "../../../../../fixtures/obsidian/active-editor";
import { sampledPath } from "../../../../../unit/domain/recognition/recognition-fixtures";
import { rectangle } from "../../../../../unit/domain/store/fixtures";
import { uuid } from "../../../../../unit/domain/schema/fixtures";

const trackFixture = useHoldFixtures();

function snapAdmission(initiallyPaused: boolean) {
  let paused = initiallyPaused;
  const pending = new Set<() => void>();
  return {
    scheduler: {
      ...immediateWorkScheduler(() => paused),
      checkpoint: (
        signal: Parameters<ReturnType<typeof immediateWorkScheduler>["checkpoint"]>[0],
        priority?: string,
      ) => {
        if (!paused || priority !== "input") return undefined;
        return new Promise<void>((resolve) => {
          const release = () => {
            pending.delete(release);
            resolve();
          };
          pending.add(release);
          signal?.addEventListener("abort", release, { once: true });
        });
      },
    },
    resume: () => {
      paused = false;
      for (const release of [...pending]) release();
    },
  };
}

function snappingFixture(
  kind: "line" | "arrow" = "line",
  options: {
    readonly pending?: boolean;
    readonly enabled?: boolean;
  } = {},
) {
  const points =
    kind === "line"
      ? sampledPath(
          [
            [0, 0],
            [120, 0],
          ],
          false,
        )
      : curvedArrowSamples();
  const startTarget = rectangle(uuid(201), -198, 2);
  const endTarget = rectangle(uuid(202), 118, 2);
  const admission = snapAdmission(options.pending ?? false);
  let enabled = options.enabled ?? true;
  const fixture = createHoldFixture({
    points,
    elements: [startTarget, endTarget],
    workScheduler: admission.scheduler,
    snap: (scene) => sceneCreationSnapPorts(scene, () => enabled),
  });
  trackFixture(fixture);
  return {
    ...fixture,
    startTarget,
    endTarget,
    resume: admission.resume,
    disable: () => {
      enabled = false;
    },
  };
}

function recognized(fixture: ReturnType<typeof snappingFixture>) {
  const element = fixture.store.get(HOLD_IDENTITY.id)?.element;
  if (element?.kind !== "line" && element?.kind !== "arrow")
    throw new Error("Expected a native linear shape.");
  return element;
}

function expectConnections(fixture: ReturnType<typeof snappingFixture>): void {
  expect(recognized(fixture)).toMatchObject({
    start: { x: 2, y: 2 },
    end: { x: 118, y: 2 },
    startConnection: {
      targetId: fixture.startTarget.id,
      anchor: { kind: "box", position: "top-right" },
    },
    endConnection: {
      targetId: fixture.endTarget.id,
      anchor: { kind: "box", position: "top-left" },
    },
  });
}

function expectVisibleCandidate(fixture: ReturnType<typeof snappingFixture>): void {
  const visible = fixture.ghost.nodes.map((node) => node.attributes.get("d"));
  expect(fixture.preview.commit()).toBe(true);
  fixture.scheduler.runAll();
  expect(buildElementPathParts(recognized(fixture)).map((part) => part.d)).toEqual(visible);
}

function moveTarget(
  fixture: ReturnType<typeof snappingFixture>,
  target: typeof fixture.startTarget,
  delta: PointV1,
): void {
  fixture.store.replace(target.id, {
    ...target,
    x: target.x + delta.x,
    y: target.y + delta.y,
    pivot: { x: target.pivot.x + delta.x, y: target.pivot.y + delta.y },
  });
  fixture.scheduler.runAll();
}

function rawPaths(fixture: ReturnType<typeof snappingFixture>): (string | undefined)[] {
  return fixture.raw.nodes
    .flatMap((node) => (node.nodes.length === 0 ? [node] : node.nodes))
    .map((node) => node.attributes.get("d"));
}

describe("recognized endpoints through native connection snapping", () => {
  it.each(["line", "arrow"] as const)(
    "attaches a real %s at both anchors, commits its visible geometry and follows target movement",
    (kind) => {
      const fixture = snappingFixture(kind);
      advanceHold(fixture);
      expect(fixture.marker.attributes.get("d")).toContain("M");
      expectVisibleCandidate(fixture);
      expectConnections(fixture);
      const element = recognized(fixture);
      expect(element.style).toMatchObject({
        outlineColor: fixture.defaults.pen.color,
        outlineWidth: 8,
        outlineOpacity: 0.5,
      });
      if (kind === "arrow") {
        expect(element).toMatchObject({ startNode: "circle", endNode: "triangle" });
        expect(element.bend).not.toBeNull();
      }
      expect(fixture.history.commandCount).toBe(1);
      expect(fixture.history.undo()).toBe(true);
      expect(fixture.store.get(HOLD_IDENTITY.id)).toBeUndefined();
      expect(fixture.history.redo()).toBe(true);
      expect(recognized(fixture)).toEqual(element);
      moveTarget(fixture, fixture.startTarget, { x: 10, y: 5 });
      expect(recognized(fixture).start).toEqual({ x: 12, y: 7 });
      expect(recognized(fixture).end).toEqual(element.end);
      moveTarget(fixture, fixture.endTarget, { x: 20, y: 10 });
      expect(recognized(fixture).end).toEqual({ x: 138, y: 12 });
      expect(recognized(fixture).startConnection).toEqual(element.startConnection);
      expect(recognized(fixture).endConnection).toEqual(element.endConnection);
    },
  );

  it.each(["setting", "temporary-override"] as const)(
    "honors disabled native connections via %s",
    (mode) => {
      const fixture = snappingFixture("line", { enabled: mode !== "setting" });
      advanceHold(fixture);
      if (mode === "temporary-override") {
        expect(fixture.marker.attributes.get("d")).toContain("M");
        expect(fixture.ghost.nodes[0]?.attributes.get("d")).toBe("M2 2L118 2");
        fixture.disable();
        fixture.preview.update(holdPointer(120, 0));
        fixture.scheduler.runAll();
      }
      expect(fixture.marker.attributes.get("d") ?? "").toBe("");
      expect(fixture.ghost.nodes[0]?.attributes.get("d")).toBe("M0 0L120 0");
      expectVisibleCandidate(fixture);
      expect(recognized(fixture)).toMatchObject({
        start: { x: 0, y: 0 },
        end: { x: 120, y: 0 },
        startConnection: null,
        endConnection: null,
      });
      expect(fixture.marker.attributes.get("d") ?? "").toBe("");
    },
  );
});

describe("hold snap cancellation and deferred lookup ownership", () => {
  it("clears candidate markers for raw movement without modifying the retained raw stroke", () => {
    const fixture = snappingFixture();
    advanceHold(fixture);
    const raw = rawPaths(fixture);
    fixture.preview.observeInputSamples([holdPointer(130, 20), holdPointer(120, 0)]);
    fixture.scheduler.runAll();
    expect(fixture.marker.attributes.get("d") ?? "").toBe("");
    expect(fixture.ghost.nodes[0]?.attributes.get("d") ?? "").toBe("");
    expect(rawPaths(fixture)).toEqual(raw);
    expect(fixture.store.get(HOLD_IDENTITY.id)).toBeUndefined();
  });

  it("releases before the hold as raw ink and never adopts an outstanding initial snap", async () => {
    const fixture = snappingFixture("line", { pending: true });
    advanceHold(fixture, 599);
    expect(fixture.preview.commit()).toBe(true);
    fixture.resume();
    await fixture.preview.completion;
    fixture.scheduler.runAll();
    expect(fixture.store.get(HOLD_IDENTITY.id)?.element.kind).toBe("stroke");
    expect(fixture.history.commandCount).toBe(1);
    expect(fixture.marker.attributes.get("d") ?? "").toBe("");
  });

  it("commits the painted candidate immediately while lookup is pending and refines its one history entry", async () => {
    const fixture = snappingFixture("arrow", { pending: true });
    advanceHold(fixture);
    expectVisibleCandidate(fixture);
    expect(recognized(fixture)).toMatchObject({ startConnection: null, endConnection: null });
    fixture.resume();
    expect(await fixture.preview.completion).toBe(true);
    expectConnections(fixture);
    expect(fixture.history.commandCount).toBe(1);
    expect(fixture.history.undo()).toBe(true);
    expect(fixture.store.get(HOLD_IDENTITY.id)).toBeUndefined();
    expect(fixture.history.redo()).toBe(true);
    expectConnections(fixture);
  });

  it.each(["stale-owner", "undo", "new-gesture"] as const)(
    "prevents pending refinement after %s",
    async (action) => {
      const fixture = snappingFixture("line", { pending: true });
      advanceHold(fixture);
      expectVisibleCandidate(fixture);
      if (action === "stale-owner") fixture.invalidate();
      if (action === "undo") fixture.history.undo();
      if (action === "new-gesture") fixture.refinement.abort();
      fixture.resume();
      expect(await fixture.preview.completion).toBe(false);
      if (action === "undo") expect(fixture.store.get(HOLD_IDENTITY.id)).toBeUndefined();
      else
        expect(recognized(fixture)).toMatchObject({ startConnection: null, endConnection: null });
      expect(fixture.marker.attributes.get("d") ?? "").toBe("");
    },
  );
});
