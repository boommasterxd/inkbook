import { afterEach, expect, it, vi } from "vitest";

import * as geometry from "../../../../src/domain/geometry/public";
import * as spatial from "../../../../src/domain/spatial/index";
import { SharedFrameScheduler } from "../../../../src/domain/scheduling/shared-frame-scheduler";
import { planPasteSliced } from "../../../../src/persistence/clipboard/operations";
import * as validation from "../../../../src/persistence/clipboard/validation";
import { emptyAggregateFacts } from "../../../../src/persistence/serialization/output/incremental-validation";
import { DocumentModelRuntime } from "../../../../src/persistence/worker/runtime/model/document-model";
import { ManualHost } from "../../../fixtures/scheduling/manual-frame-host";
import { createDecodedClipboardFixture } from "../../../unit/persistence/clipboard/fixtures";
import { INTERACTION_REFRESH_PROFILE } from "../../interaction-refresh-profile";
import {
  CLIPBOARD_ELEMENTS,
  createClipboardLimitFixture,
  createMinimalPersistenceFixture,
} from "../fixtures";

afterEach(() => vi.restoreAllMocks());

function clipboardFixture() {
  return createDecodedClipboardFixture(createClipboardLimitFixture());
}

function uuid(index: number): string {
  return `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

/** Only real boundary calls advance simulated scheduling time, never claimed execution time. */
function planningProbe() {
  const host = new ManualHost();
  host.budget = INTERACTION_REFRESH_PROFILE.interruptibleSliceDeadlineMs;
  host.frameInterval = INTERACTION_REFRESH_PROFILE.frameDurationMs;
  const scheduler = new SharedFrameScheduler(host);
  const slices: number[] = [];
  let work = 0;
  let active = true;
  scheduler.deadline();
  // Another owning-window consumer already spent most of this shared epoch.
  host.time = host.budget - 0.1;
  return {
    scheduler,
    host,
    slices,
    observe: () => {
      if (!active) return;
      work += 1;
      host.time += 0.25;
    },
    checkpoint: () => {
      const pending = scheduler.checkpoint();
      if (pending === undefined) return undefined;
      slices.push(work);
      work = 0;
      host.time += host.frameInterval;
      host.frame();
      if (host.hasTimer(0)) host.timer(0);
      return pending;
    },
    finish: () => {
      active = false;
      slices.push(work);
    },
  };
}

function observePlanningWork(decoded: ReturnType<typeof clipboardFixture>, observe: () => void) {
  decoded.payload.elements = decoded.payload.elements.map(
    (entry) =>
      new Proxy(entry, {
        get: (target, key, receiver) => {
          observe();
          return Reflect.get(target, key, receiver) as unknown;
        },
      }),
  );
  const bounds = validation.getValidatedClipboardBounds(decoded.payload)!;
  const observedBounds = bounds.map(
    (bound) =>
      new Proxy(bound, {
        get: (target, key, receiver) => {
          observe();
          return Reflect.get(target, key, receiver) as unknown;
        },
      }),
  );
  const getBounds = validation.getValidatedClipboardBounds;
  vi.spyOn(validation, "getValidatedClipboardBounds").mockImplementation((payload) =>
    payload === decoded.payload ? observedBounds : getBounds(payload),
  );
  const translate = geometry.translateElementGeometry;
  vi.spyOn(geometry, "translateElementGeometry").mockImplementation((element, translation) => {
    observe();
    return new Proxy(translate(element, translation), {
      get: (target, key, receiver) => {
        observe();
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
  });
  const membership = spatial.spatialCellMembershipCount;
  vi.spyOn(spatial, "spatialCellMembershipCount").mockImplementation((bound) => {
    observe();
    return membership(bound);
  });
}

it("bounds actual planning work at clipboard capacity under one shared cadence budget", async () => {
  const decoded = clipboardFixture();
  const probe = planningProbe();
  observePlanningWork(decoded, probe.observe);
  let generated = 0;
  try {
    const result = await planPasteSliced(
      {
        decoded,
        page: createMinimalPersistenceFixture().page,
        target: { x: 1024, y: 512 },
        commandTimestamp: 1,
        createId: () => {
          probe.observe();
          return uuid(generated++);
        },
        validatedModel: { facts: emptyAggregateFacts(), hasExistingId: () => false },
      },
      { signal: new AbortController().signal, checkpoint: probe.checkpoint },
      () => undefined,
    );
    probe.finish();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(generated).toBe(CLIPBOARD_ELEMENTS);
    expect(result.value.elements).toHaveLength(CLIPBOARD_ELEMENTS);
    expect(new Set(result.value.selectedIds).size).toBe(CLIPBOARD_ELEMENTS);
    expect(probe.slices[0]).toBeLessThanOrEqual(2);
    // One element's atomic property reads may overshoot; another element must await admission.
    expect(Math.max(...probe.slices)).toBeLessThanOrEqual(Math.ceil(probe.host.budget / 0.25) + 8);
    expect(probe.slices.length).toBeGreaterThan(10);
    const first = result.value.elements[0]!;
    const original = decoded.payload.elements[0]!.element;
    if (first.kind !== "stroke" || original.kind !== "stroke")
      throw new Error("Expected a stroke.");
    expect(first.points).toBe(original.points);
  } finally {
    probe.scheduler.dispose();
  }
  expect(probe.host.pendingFrames).toBe(0);
  expect(probe.host.pendingTimers).toBe(0);
}, 120_000);

it("continues the complete plan without a handoff while the shared budget remains", async () => {
  const decoded = clipboardFixture();
  let generated = 0;
  const pending = planPasteSliced(
    {
      decoded,
      existingElements: [],
      page: createMinimalPersistenceFixture().page,
      target: { x: 1024, y: 512 },
      commandTimestamp: 1,
      createId: () => uuid(generated++),
    },
    { signal: new AbortController().signal, checkpoint: () => undefined },
    () => undefined,
  );
  expect(generated).toBe(CLIPBOARD_ELEMENTS);
  await expect(pending).resolves.toMatchObject({ ok: true });
}, 120_000);

it.each(["abort", "revision", "scheduler"])(
  "abandons a suspended worker paste after %s without publishing a partial plan",
  async (cause) => {
    const decoded = clipboardFixture();
    const model = new DocumentModelRuntime();
    model.initialize(createMinimalPersistenceFixture());
    const controller = new AbortController();
    let generated = 0;
    let published = false;
    const pending = model.planClipboardPasteSliced(
      0,
      { customText: decoded.customText },
      {
        commandTimestamp: 1,
        createId: () => uuid(generated++),
        invocation: { kind: "toolbar", visibleCanvasCenter: { x: 1024, y: 512 } },
        context: {
          signal: controller.signal,
          checkpoint: () =>
            generated < 8
              ? undefined
              : Promise.resolve().then(() => {
                  if (cause === "abort") controller.abort();
                  if (cause === "revision") model.initialize(createMinimalPersistenceFixture(1));
                  if (cause === "scheduler") throw new Error("Scheduler disposed.");
                }),
        },
      },
    );
    void pending.then(
      () => {
        published = true;
      },
      () => undefined,
    );
    try {
      await expect(pending).rejects.toThrow(
        cause === "revision"
          ? "basis-revision-mismatch"
          : cause === "scheduler"
            ? "Scheduler disposed."
            : /abort/i,
      );
      expect(generated).toBe(8);
      expect(published).toBe(false);
    } finally {
      model.clear();
    }
  },
  120_000,
);
