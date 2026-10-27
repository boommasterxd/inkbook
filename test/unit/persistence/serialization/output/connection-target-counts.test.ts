import { expect, it, vi } from "vitest";

import * as counts from "../../../../../src/persistence/serialization/output/connection-target-counts";
import { IncrementalDocumentSerializer } from "../../../../../src/persistence/serialization/public";
import { completeSerializationSteps } from "../../../../../src/persistence/serialization/output/serialization-model-preparation";
import * as canonical from "../../../../../src/persistence/serialization/metadata/canonical-snapshot";
import { SharedFrameScheduler } from "../../../../../src/domain/scheduling/shared-frame-scheduler";
import { ManualHost } from "../../../../fixtures/scheduling/manual-frame-host";
import { connectionChain } from "../../../../fixtures/domain/connection-chain";
import { connectedLine, rectangle } from "../../../domain/store/fixtures";
import { createSnapshot, uuid } from "../fixtures";

it.each(["abort", "supersede", "unexpired"] as const)(
  "consults central admission after the final canonical record before publication: %s",
  async (mode) => {
    const target = rectangle();
    const source = connectedLine(target);
    const snapshot = createSnapshot([target, source]);
    const serializer = new IncrementalDocumentSerializer();
    expect(serializer.reset(snapshot).ok).toBe(true);
    const host = new ManualHost();
    const scheduler = new SharedFrameScheduler(host);
    scheduler.deadline();
    const controller = new AbortController();
    const original = canonical.canonicalElement;
    const copy = vi.spyOn(canonical, "canonicalElement").mockImplementation((...args) => {
      const result = original(...args);
      host.time = mode === "unexpired" ? 1 : host.budget;
      return result;
    });
    try {
      const operation = serializer.applyDeltaSliced(
        {
          baseModelRevision: 7,
          modelRevision: 8,
          changedElements: [{ ...source, startConnection: null }],
        },
        {
          signal: controller.signal,
          checkpoint: () => scheduler.checkpoint(controller.signal),
        },
        true,
      );
      expect(copy).toHaveBeenCalledOnce();
      if (mode === "unexpired") {
        expect(await operation).toEqual({ ok: true, value: undefined });
        expect(host.frameRequests).toBe(0);
        expect(serializer.currentRevision()).toBe(8);
        expect(serializer.instrumentation.connectionTargetEntries).toBe(0);
        return;
      }
      expect(host.pendingFrames).toBe(1);
      expect(serializer.currentRevision()).toBe(7);
      expect(serializer.instrumentation.connectionTargetEntries).toBe(1);
      if (mode === "abort") {
        const rejected = expect(operation).rejects.toThrow();
        controller.abort();
        await rejected;
      } else {
        expect(serializer.reset(snapshot).ok).toBe(true);
        host.time = host.frameInterval;
        host.frame();
        expect(await operation).toMatchObject({
          ok: false,
          error: { code: "base-revision-mismatch" },
        });
      }
      expect(serializer.currentRevision()).toBe(7);
      expect(serializer.instrumentation.connectionTargetEntries).toBe(1);
      expect(serializer.currentSnapshot()!.elements[1]).toMatchObject({
        startConnection: source.startConnection,
      });
    } finally {
      copy.mockRestore();
      scheduler.dispose();
      serializer.clear();
    }
  },
);

it("retains shared target counts across detachment, removal, re-addition and reset", () => {
  const target = rectangle();
  const first = connectedLine(target);
  const second = { ...first, id: uuid(20) };
  const serializer = new IncrementalDocumentSerializer();
  expect(serializer.reset(createSnapshot([target, first, second])).ok).toBe(true);
  expect(serializer.instrumentation.connectionTargetEntries).toBe(1);
  expect(
    serializer.applyDelta({
      baseModelRevision: 7,
      modelRevision: 8,
      changedElements: [{ ...first, startConnection: null }],
    }).ok,
  ).toBe(true);
  const moved = { ...target, x: target.x + 10, pivot: { ...target.pivot, x: target.pivot.x + 10 } };
  expect(
    serializer.applyDelta({ baseModelRevision: 8, modelRevision: 9, changedElements: [moved] }),
  ).toMatchObject({
    ok: false,
    error: { validationError: { code: "connection-position-mismatch" } },
  });
  expect(
    serializer.applyDelta({
      baseModelRevision: 8,
      modelRevision: 9,
      removedIds: [second.id],
      orderChanges: { content: [target.id, first.id] },
    }).ok,
  ).toBe(true);
  expect(serializer.instrumentation.connectionTargetEntries).toBe(0);
  expect(
    serializer.applyDelta({ baseModelRevision: 9, modelRevision: 10, changedElements: [moved] }).ok,
  ).toBe(true);
  expect(
    serializer.applyDelta({
      baseModelRevision: 10,
      modelRevision: 11,
      changedElements: [target, second],
      orderChanges: { content: [target.id, first.id, second.id] },
    }).ok,
  ).toBe(true);
  expect(serializer.instrumentation.connectionTargetEntries).toBe(1);
  expect(serializer.reset(createSnapshot()).ok).toBe(true);
  expect(serializer.instrumentation.connectionTargetEntries).toBe(0);
  expect(serializer.reset(createSnapshot([target, first])).ok).toBe(true);
  serializer.clear();
  expect(serializer.instrumentation.connectionTargetEntries).toBe(0);
});

it("rejects removed targets, ineligible replacements and imported dependency cycles atomically", () => {
  const target = rectangle();
  const source = connectedLine(target);
  const serializer = new IncrementalDocumentSerializer();
  expect(serializer.reset(createSnapshot([target, source])).ok).toBe(true);
  expect(
    serializer.applyDelta({
      baseModelRevision: 7,
      modelRevision: 8,
      removedIds: [target.id],
      orderChanges: { content: [source.id] },
    }),
  ).toMatchObject({ ok: false, error: { validationError: { code: "invalid-connection-target" } } });
  expect(
    serializer.applyDelta({
      baseModelRevision: 7,
      modelRevision: 8,
      changedElements: [{ ...source, id: target.id, startConnection: null }],
    }),
  ).toMatchObject({ ok: false, error: { validationError: { code: "invalid-anchor" } } });
  expect(serializer.currentRevision()).toBe(7);
  expect(serializer.instrumentation.connectionTargetEntries).toBe(1);
  const chain = connectionChain(2);
  expect(serializer.reset(createSnapshot(chain)).ok).toBe(true);
  expect(
    serializer.applyDelta({
      baseModelRevision: 7,
      modelRevision: 8,
      changedElements: [
        {
          ...chain[0]!,
          startConnection: {
            targetId: chain[1]!.id,
            anchor: { kind: "linear-endpoint", endpoint: "start" },
          },
        },
      ],
    }),
  ).toMatchObject({ ok: false, error: { validationError: { code: "invalid-connection-target" } } });
  expect(serializer.currentRevision()).toBe(7);
  expect(serializer.instrumentation.connectionTargetEntries).toBe(1);
});

it("discards a cancelled target-count patch and retains revision-bound relation validation", async () => {
  const elements = connectionChain(300);
  const serializer = new IncrementalDocumentSerializer();
  expect(serializer.reset(createSnapshot(elements)).ok).toBe(true);
  const changedElements = elements.map((element) => ({ ...element, startConnection: null }));
  const delta = { baseModelRevision: 7, modelRevision: 8, changedElements };
  const controller = new AbortController();
  const patch = vi.spyOn(counts, "prepareConnectionTargetCounts");
  let copiedEntries = 0;
  let iteration: { mockRestore(): void } | undefined;
  try {
    await expect(
      serializer.applyDeltaSliced(delta, {
        signal: controller.signal,
        checkpoint: () => {
          const current = patch.mock.calls[0]?.[0];
          if (current !== undefined && iteration === undefined) {
            const entries = current[Symbol.iterator].bind(current);
            iteration = vi.spyOn(current, Symbol.iterator).mockImplementation(function* () {
              for (const entry of entries()) {
                copiedEntries += 1;
                yield entry;
              }
              return undefined;
            });
          }
          if (copiedEntries > 0) controller.abort();
          return undefined;
        },
      }),
    ).rejects.toThrow();
    expect(patch).toHaveBeenCalledOnce();
    expect(copiedEntries).toBeGreaterThan(0);
    expect(copiedEntries).toBeLessThanOrEqual(256);
    expect(serializer.currentRevision()).toBe(7);
    expect(serializer.instrumentation.connectionTargetEntries).toBe(299);
    expect(
      serializer.applyDelta({
        baseModelRevision: 7,
        modelRevision: 8,
        changedElements: [{ ...elements[0]!, start: { x: 101, y: 100 } }],
      }),
    ).toMatchObject({
      ok: false,
      error: { validationError: { code: "connection-position-mismatch" } },
    });
    expect(serializer.applyDelta(delta).ok).toBe(true);
    expect(serializer.instrumentation.connectionTargetEntries).toBe(0);
  } finally {
    iteration?.mockRestore();
    patch.mockRestore();
    serializer.clear();
  }
});

it("reuses the complete target index without traversing it for unchanged connection counts", () => {
  const elements = connectionChain(1000);
  const byId = new Map(elements.map((element) => [element.id, element]));
  const current = new Map<string, number>();
  for (const element of elements) counts.updateConnectionTargetCounts(current, element, 1);
  const iteration = vi.spyOn(current, Symbol.iterator);
  try {
    const unchanged = new Map<string, (typeof elements)[number]>();
    expect(
      completeSerializationSteps(
        counts.prepareConnectionTargetCounts(current, byId, unchanged, new Set(), 256),
      ),
    ).toBe(current);
    const source = elements[1]!;
    const styled = { ...source, style: { ...source.style, outlineOpacity: 0.5 } };
    expect(
      completeSerializationSteps(
        counts.prepareConnectionTargetCounts(
          current,
          byId,
          new Map([[styled.id, styled]]),
          new Set(),
          256,
        ),
      ),
    ).toBe(current);
    expect(iteration).not.toHaveBeenCalled();
    const detached = { ...source, startConnection: null };
    const next = completeSerializationSteps(
      counts.prepareConnectionTargetCounts(
        current,
        byId,
        new Map([[detached.id, detached]]),
        new Set(),
        256,
      ),
    );
    expect(next).not.toBe(current);
    expect(next.size).toBe(998);
    expect(current.size).toBe(999);
    expect(next.has(elements[0]!.id)).toBe(false);
    expect(current.get(elements[0]!.id)).toBe(1);
  } finally {
    iteration.mockRestore();
  }
});

it("does not replace the current index when cancellation interrupts a full model build", async () => {
  const serializer = new IncrementalDocumentSerializer();
  expect(serializer.reset(createSnapshot(connectionChain(2))).ok).toBe(true);
  const update = vi.spyOn(counts, "updateConnectionTargetCounts");
  const controller = new AbortController();
  try {
    await expect(
      serializer.resetRuntimeSliced(createSnapshot(connectionChain(300)), {
        signal: controller.signal,
        checkpoint: () => {
          if (update.mock.calls.length >= 256) controller.abort();
          return undefined;
        },
      }),
    ).rejects.toThrow();
    expect(update).toHaveBeenCalledTimes(256);
    expect(serializer.currentElementCount()).toBe(2);
    expect(serializer.instrumentation.connectionTargetEntries).toBe(1);
  } finally {
    update.mockRestore();
    serializer.clear();
  }
});
