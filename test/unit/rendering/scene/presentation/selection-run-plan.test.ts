import { expect, it, vi } from "vitest";
import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import { createMountedElement } from "../../../../../src/rendering/scene/content/mounted-element";
import { createInstrumentation } from "../../../../../src/rendering/scene/instrumentation";
import {
  SelectionRunPlanning,
  canonicalRunMember,
} from "../../../../../src/rendering/scene/presentation/selection-run-plan";
import type { SceneStorePort } from "../../../../../src/rendering/scene/types";
import { FakeDocument, fakeRectangleRecord } from "../fakes";

it("does not acquire or walk the complete store order for selections covered by the existing snapshot budget", () => {
  const beginOrder = vi.fn();
  const store = { beginOrder } as unknown as SceneStorePort;
  const plan = new SelectionRunPlanning(
    new Set(Array.from({ length: 256 }, (_, i) => String(i))),
    store,
    new Map(),
  );
  expect(plan.step()).toBe(true);
  expect(plan.result).toBeUndefined();
  expect(beginOrder).not.toHaveBeenCalled();
});

it("admits only canonical quiet geometry, without another owner of transform or opacity", () => {
  const record = fakeRectangleRecord("a", 0, 10),
    entry = createMountedElement(
      new FakeDocument() as never,
      record,
      buildElementPathParts(record.element),
      createInstrumentation(),
    );
  expect(canonicalRunMember(entry)).toBe(true);
  entry.appliedPreviewTransform = "scale(2)";
  expect(canonicalRunMember(entry)).toBe(false);
  entry.appliedPreviewTransform = null;
  entry.motionActive = true;
  expect(canonicalRunMember(entry)).toBe(false);
  entry.motionActive = false;
  entry.fadeActive = true;
  expect(canonicalRunMember(entry)).toBe(false);
  entry.fadeActive = false;
  entry.displayedPathParts = [...entry.pathParts];
  expect(canonicalRunMember(entry)).toBe(false);
});

it("readiness queries between planning steps never consume the unselected gap that separates rank runs", () => {
  const document = new FakeDocument(),
    stats = createInstrumentation();
  const records = Array.from({ length: 601 }, (_, i) => fakeRectangleRecord(String(i), i, i));
  const selectedRecords = records.filter((_, i) => i !== 128),
    selection = new Set(selectedRecords.map((record) => record.id));
  const mounted = new Map(
    selectedRecords.map((record) => [
      record.id,
      createMountedElement(document as never, record, buildElementPathParts(record.element), stats),
    ]),
  );
  let index = 0;
  const advance = vi.fn(() =>
    index < records.length
      ? { id: records[index++]!.id, done: false, stale: false }
      : { done: true, stale: false },
  );
  const store = {
    beginOrder: () => ({ advance, cancel: () => undefined }),
    get: (id: string) => records[Number(id)],
  } as unknown as SceneStorePort;
  const plan = new SelectionRunPlanning(selection, store, mounted);
  while (!plan.done) {
    const calls = advance.mock.calls.length;
    expect(plan.valid()).toBe(false);
    expect(advance).toHaveBeenCalledTimes(calls);
    plan.step();
  }
  expect(plan.result?.groups[0]?.entries).toHaveLength(472);
  expect(plan.result?.exceptions).toHaveLength(128);
  expect(plan.result?.members.size).toBe(600);
  expect(plan.result?.legacyTransformSurfaces).toBe(344);
  expect(plan.result?.residualTransformSurfaces).toBe(128);
  expect(plan.result?.sharedTransformSurfaces).toBe(2);
  expect(plan.valid()).toBe(true);
});
