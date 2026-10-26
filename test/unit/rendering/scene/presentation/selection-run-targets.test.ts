import { afterEach, expect, it, vi } from "vitest";
import type { MountedSceneElement } from "../../../../../src/rendering/scene/content/mounted-element";
import { SelectionRunTargets } from "../../../../../src/rendering/scene/presentation/selection-run-targets";
import type {
  SceneDeltaEntry,
  SceneElementRecord,
  SceneStorePort,
} from "../../../../../src/rendering/scene/types";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { fakeRectangleRecord } from "../fakes";

function record(id: string, version: number): SceneElementRecord {
  return Object.freeze({
    ...fakeRectangleRecord(id, id === "left" ? 0 : 1, version * 30),
    geometryVersion: version,
    paintVersion: version,
  });
}

function delta(target: SceneElementRecord): SceneDeltaEntry {
  return {
    id: target.id,
    domains: ["geometry"],
    after: target.element,
    afterBounds: target.bounds,
    afterGeometryVersion: target.geometryVersion,
    afterPaintVersion: target.paintVersion,
  };
}

function pressureRecord(version: number, scalarCount: number): SceneElementRecord {
  const samples = Array<number>(scalarCount).fill(0.5);
  Object.freeze(samples);
  const points = new Proxy(samples, {
    get: (_target, property) => {
      if (property !== "length") throw new Error("Target accounting must not read point samples.");
      return scalarCount;
    },
  });
  return Object.freeze({
    ...record("left", version),
    element: Object.freeze({ ...indexedStroke(0), id: "left", points }),
  });
}

function setup() {
  const targets = new SelectionRunTargets();
  const get = vi.fn<SceneStorePort["get"]>(() => undefined);
  const store = { get } as unknown as SceneStorePort;
  for (const id of ["left", "right"]) {
    const initial = record(id, 0);
    targets.prepare({ id, band: initial.band, rank: initial.rank } as MountedSceneElement, initial);
  }
  const capture = (id: string, version: number) => {
    const target = record(id, version);
    expect(targets.capture(id, delta(target), store)).toBe(true);
    return target;
  };
  return { targets, capture, get, store };
}

afterEach(() => vi.restoreAllMocks());

it("pins A while C and D coalesce and keeps the native path free of Store reads", () => {
  const { targets, capture, get } = setup();
  const a = capture("left", 1);
  capture("right", 1);
  targets.begin();
  capture("left", 2);
  const d = capture("left", 3);
  expect(targets.record("left")?.element).toBe(a.element);
  expect(targets.record("right")?.geometryVersion).toBe(1);
  expect(targets.finish()).toBe(true);
  expect(targets.record("left")?.element).toBe(d.element);
  expect(targets.record("right")?.geometryVersion).toBe(1);
  expect(targets.finish()).toBe(false);
  expect(get).not.toHaveBeenCalled();
});

it("promotes unvisited C before a D capture replaces its latest reference", () => {
  const { targets, capture } = setup();
  capture("left", 1);
  capture("right", 1);
  targets.begin();
  const c = capture("left", 2);
  expect(targets.finish()).toBe(true);
  const d = capture("left", 3);
  expect(targets.record("left")?.element).toBe(c.element);
  expect(targets.finish()).toBe(true);
  expect(targets.record("left")?.element).toBe(d.element);
  expect(targets.finish()).toBe(false);
});

it("starts the next inactive capture phase once and bounds ownership across commits", () => {
  const { targets, capture } = setup();
  const bytes = targets.memoryUsage();
  capture("left", 1);
  capture("right", 1);
  targets.begin();
  expect(targets.finish()).toBe(false);
  const next = capture("left", 2);
  capture("right", 2);
  targets.begin();
  expect(targets.record("left")?.element).toBe(next.element);
  for (let version = 3; version < 100; version += 1) capture("left", version);
  expect(targets.record("left")?.element).toBe(next.element);
  expect(targets.memoryUsage()).toBe(bytes + 128);
  expect(targets.finish()).toBe(true);
  expect(targets.record("left")?.geometryVersion).toBe(99);
  expect(targets.finish()).toBe(false);
  targets.discard();
  expect(targets.record("left")).toBeUndefined();
  expect(targets.memoryUsage()).toBeLessThan(bytes);
});

it("performs no member iteration while beginning, finishing, reading or capturing", () => {
  const { targets, store } = setup();
  const target = record("left", 1);
  const iterators = ["values", "entries", "keys", "forEach"] as const;
  const spies = [
    ...iterators.map((method) => vi.spyOn(Map.prototype, method)),
    vi.spyOn(Map.prototype, Symbol.iterator),
  ];
  const before = spies.map((spy) => spy.mock.calls.length);
  const captured = targets.capture("left", delta(target), store);
  targets.begin();
  const pinned = targets.record("left");
  const queued = targets.capture("left", delta(record("left", 2)), store);
  const more = targets.finish();
  const latest = targets.record("left");
  const after = spies.map((spy) => spy.mock.calls.length);
  vi.restoreAllMocks();
  expect(after).toEqual(before);
  expect(captured && queued && more).toBe(true);
  expect(pinned?.geometryVersion).toBe(1);
  expect(latest?.geometryVersion).toBe(2);
});

it("uses one legacy Store lookup and ignores unknown or removed members", () => {
  const { targets, get, store } = setup();
  const legacy = record("left", 1);
  get.mockReturnValue(legacy);
  expect(targets.capture("left", { id: "left", domains: ["geometry"] }, store)).toBe(true);
  targets.begin();
  expect(targets.record("left")).toBe(legacy);
  expect(targets.capture("missing", delta(record("missing", 1)), store)).toBe(false);
  expect(targets.capture("left", { id: "left", domains: [], after: null }, store)).toBe(false);
  expect(get).toHaveBeenCalledTimes(1);
});

it("accounts retained pressure payloads through coalescing, lazy promotion and release", () => {
  const targets = new SelectionRunTargets();
  const get = vi.fn<SceneStorePort["get"]>(() => undefined);
  const store = { get } as unknown as SceneStorePort;
  const a = pressureRecord(1, 12);
  const c = pressureRecord(2, 24);
  const d = pressureRecord(3, 6);
  const entry = {
    id: "left",
    band: a.band,
    rank: a.rank,
  } as MountedSceneElement;
  const empty = targets.memoryUsage();
  const bookkeeping = empty + 128 + "left".length * 2;
  const aBytes = 128 + 12 * 8;
  const cBytes = 128 + 24 * 8;
  const dBytes = 128 + 6 * 8;
  targets.prepare(entry, a);
  expect(targets.memoryUsage()).toBe(bookkeeping + aBytes);
  targets.begin();
  targets.capture("left", delta(c), store);
  expect(targets.memoryUsage()).toBe(bookkeeping + aBytes + cBytes);
  expect(targets.finish()).toBe(true);
  expect(targets.memoryUsage()).toBe(bookkeeping + aBytes + cBytes);
  targets.capture("left", delta(d), store);
  expect(targets.record("left")?.element).toBe(c.element);
  expect(targets.memoryUsage()).toBe(bookkeeping + cBytes + dBytes);
  expect(targets.finish()).toBe(true);
  expect(targets.record("left")?.element).toBe(d.element);
  expect(targets.memoryUsage()).toBe(bookkeeping + dBytes);
  expect(targets.finish()).toBe(false);
  targets.prepare(entry, a);
  expect(targets.memoryUsage()).toBe(bookkeeping + aBytes);
  targets.begin();
  const sharedPoints = Object.freeze({
    ...a,
    geometryVersion: 4,
    element: Object.freeze({ ...a.element }),
  });
  targets.capture("left", delta(sharedPoints), store);
  expect(targets.memoryUsage()).toBe(bookkeeping + 128 * 2 + 12 * 8);
  expect(targets.finish()).toBe(true);
  expect(targets.record("left")?.element).toBe(sharedPoints.element);
  expect(targets.memoryUsage()).toBe(bookkeeping + aBytes);
  targets.discard();
  expect(targets.memoryUsage()).toBe(empty);
  expect(targets.record("left")).toBeUndefined();
  expect(get).not.toHaveBeenCalled();
});
