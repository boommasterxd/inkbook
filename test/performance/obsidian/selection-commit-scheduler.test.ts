import { expect, it, vi } from "vitest";

import type { InkElementV1 } from "../../../src/domain/schema/public";
import { SharedFrameScheduler } from "../../../src/domain/scheduling/shared-frame-scheduler";
import {
  ElementStore,
  type PreparedElementReplacement,
  type StoreSliceScheduler,
} from "../../../src/domain/store/public";
import type { ElementRecord } from "../../../src/domain/store/types";
import { createElementStoreBuilder } from "../../../src/domain/store/element-store-builder";
import { PreparedElementHistory } from "../../../src/obsidian/embeds/active-editor/prepared-element-history";
import {
  ActiveEditorHistory,
  type AppliedAsyncHistoryTransition,
} from "../../../src/obsidian/embeds/active-editor/history";
import { ActiveDocumentHistory } from "../../../src/obsidian/embeds/active-editor/document-history";
import type { EditableDocumentModel } from "../../../src/obsidian/embeds/document-model-port";
import {
  createVaultElementPreparationActions,
  prepareVaultElementReplacement,
} from "../../../src/obsidian/embeds/vault-document-model";
import { createWorkspaceDocumentRuntimes } from "../../../src/obsidian/embeds/workspace-runtime-workers";
import { WorkerDocumentRuntimePort } from "../../../src/persistence/worker/runtime/worker-bridge";
import { indexedStroke } from "../../fixtures/editor/stroke";
import { TestWorkerEndpoint } from "../../fixtures/persistence/worker-endpoint";
import { createTestStroke, createWorkerSnapshot } from "../../fixtures/persistence/worker-snapshot";
import { ManualHost } from "../../fixtures/scheduling/manual-frame-host";
import { INTERACTION_REFRESH_PROFILE } from "../interaction-refresh-profile";

const profile = INTERACTION_REFRESH_PROFILE;

function sharedWorkspaceScheduler() {
  const host = new ManualHost();
  host.budget = profile.interruptibleSliceDeadlineMs;
  host.frameInterval = profile.frameDurationMs;
  const scheduler = new SharedFrameScheduler(host);
  const ownerWindow = {
    performance: { now: () => host.time, timeOrigin: 1_000 },
  } as unknown as Window;
  const runtimes = createWorkspaceDocumentRuntimes({
    fallbackWindow: () => ownerWindow,
    owningWindow: () => ownerWindow,
    ownerWindowVersion: () => 0,
    subscribeSchedulingProfile: () => () => undefined,
    workScheduler: () => scheduler,
  });
  return { host, runtimes, scheduler };
}

function selectionUnderBusyScene() {
  const { host, runtimes, scheduler } = sharedWorkspaceScheduler();
  const token = Object.freeze({}) as PreparedElementReplacement;
  const prepare = vi.fn(async (_elements: readonly InkElementV1[], slice: StoreSliceScheduler) => {
    for (let unit = 0; unit < 2; unit += 1) {
      host.time += host.budget;
      if (slice.shouldYield()) await slice.yieldControl();
    }
    return { status: "prepared" as const, token };
  });
  const store = { prepareElementReplacement: prepare } as unknown as ElementStore;
  const commit = vi.fn(() => "committed" as const);
  const model = {
    commitPreparedElementReplacement: commit,
    prepareElementReplacement: (
      elements: readonly InkElementV1[],
      cancellation: { isCancelled(): boolean },
    ) =>
      prepareVaultElementReplacement({
        active: true,
        cancellation,
        replacements: elements,
        scheduler: (isCancelled) =>
          runtimes.createStoreScheduler("drawing.svg", isCancelled, "frame"),
        store,
      }),
  } as unknown as EditableDocumentModel;
  const registered: { undo?: () => Promise<boolean> } = {};
  const history = {
    registerApplied: (transition: AppliedAsyncHistoryTransition) => {
      registered.undo = transition.undo;
      return true;
    },
  } as unknown as ActiveEditorHistory;
  const prepared = new PreparedElementHistory({
    history,
    isAttached: () => true,
    model,
    motion: { beginPreviewCommit: () => ({ arm: () => true, cancel: () => undefined }) },
    onPendingChanged: () => undefined,
    workScheduler: runtimes.workScheduler("drawing.svg"),
  });
  return { commit, host, prepare, prepared, registered, scheduler };
}

async function advanceBusyFrames(
  host: ManualHost,
  done: () => boolean,
  maximumFrames = 24,
): Promise<number> {
  let frames = 0;
  while (frames < maximumFrames && !done()) {
    host.time += host.frameInterval;
    host.frame();
    frames += 1;
    await flushMicrotasks();
    for (let task = 0; task < 12 && host.hasTimer(0); task += 1) {
      host.timer(0);
      await flushMicrotasks();
    }
    expect(host.pendingFrames).toBeLessThanOrEqual(1);
    expect(host.pendingTimers).toBeLessThanOrEqual(2);
  }
  expect(done()).toBe(true);
  return frames;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

class ObservedRecords extends Map<string, ElementRecord> {
  public constructor(
    records: ReadonlyMap<string, ElementRecord>,
    private readonly observe: () => void,
  ) {
    super(records);
  }

  public override get(id: string): ElementRecord | undefined {
    this.observe();
    return super.get(id);
  }

  public override has(id: string): boolean {
    this.observe();
    return super.has(id);
  }
}

async function structuralHistoryUnderBusyScene() {
  const { host, runtimes, scheduler } = sharedWorkspaceScheduler();
  const work = { active: false, recordReads: 0 };
  const elements = Array.from({ length: 10_000 }, (_, index) => indexedStroke(index));
  const builder = createElementStoreBuilder(
    { shouldYield: () => false, yieldControl: () => Promise.resolve() },
    (state) =>
      ElementStore.adoptTimeSlicedState({
        ...state,
        records: new ObservedRecords(state.records, () => {
          if (!work.active) return;
          work.recordReads += 1;
          // Charge only actual lookups in the authoritative normalized record map.
          // This is simulated work cost, independent of checkpoint invocation counts.
          host.time += host.budget / 1_000;
        }),
      }),
  );
  await builder.append(elements);
  const store = await builder.finalize();
  if (store === null) throw new Error("Structural history fixture could not be initialized.");
  let revision = 0;
  const model = {
    get revision() {
      return revision;
    },
    store,
    ...createVaultElementPreparationActions({
      active: () => true,
      replacementActive: () => true,
      replacementStore: () => store,
      run: (operation) => operation(),
      scheduler: (cancelled, priority) =>
        runtimes.createStoreScheduler("drawing.svg", cancelled, priority),
      store,
    }),
    commitPreparedElementMutation: (token) => {
      const result = store.commitPreparedElementMutation(token);
      if (result.status === "committed") revision += 1;
      return result.transition;
    },
  } satisfies Pick<
    EditableDocumentModel,
    | "revision"
    | "store"
    | "commitPreparedElementMutation"
    | "prepareElementMutation"
    | "prepareElementRemoval"
    | "prepareElementReplacement"
  >;
  const history = new ActiveEditorHistory(model as unknown as EditableDocumentModel);
  const document = new ActiveDocumentHistory({
    history,
    model: model as unknown as EditableDocumentModel,
  });
  return { document, elements, history, host, model, scheduler, store, work };
}

it(`publishes real 10K removal, Undo and Redo at ${profile.refreshRate} Hz beside budget-filling scene frames`, async ({
  annotate,
}) => {
  const { document, elements, history, host, model, scheduler, store, work } =
    await structuralHistoryUnderBusyScene();
  const ids = elements.map(({ id }) => id);
  const initialBounds = ids.map((id) => store.get(id)!.bounds);
  const published = vi.fn();
  const unsubscribe = store.subscribe(published);
  let sceneFrames = 0;
  const scene = () => {
    sceneFrames += 1;
    host.time += host.budget;
    scheduler.requestFrame(scene, "frame");
  };
  scheduler.requestFrame(scene, "frame");
  const run = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
    const sceneBefore = sceneFrames;
    const input = vi.fn(() => expect(sceneFrames).toBe(sceneBefore));
    scheduler.requestFrame(input, "input");
    scheduler.deadline();
    host.time += host.budget;
    work.recordReads = 0;
    work.active = true;
    let complete = false;
    const pending = operation().finally(() => {
      complete = true;
    });
    await advanceBusyFrames(host, () => complete, 512);
    work.active = false;
    expect(input).toHaveBeenCalledOnce();
    expect(sceneFrames).toBeGreaterThan(sceneBefore);
    await annotate(`${label}: authoritative record lookups=${work.recordReads}`, "performance");
    return pending;
  };
  try {
    let current = true;
    await expect(
      run("cancelled remove", () => {
        const pending = document.remove(ids, () => current);
        current = false;
        return pending;
      }),
    ).resolves.toBe("stale");
    expect(store.size).toBe(10_000);
    expect(published).not.toHaveBeenCalled();
    expect(history.commandCount).toBe(0);

    // Ten map-lookup passes cover the finite planner/history stages for this 10K fixture.
    await expect(run("remove", () => document.remove(ids))).resolves.toBe("applied");
    expect(work.recordReads).toBeGreaterThanOrEqual(10_000);
    expect(work.recordReads).toBeLessThanOrEqual(100_000);
    expect(store.size).toBe(0);
    expect(model.revision).toBe(1);
    expect(history.commandCount).toBe(1);

    await expect(run("undo", () => history.undoAsync())).resolves.toBe(true);
    expect(work.recordReads).toBeGreaterThanOrEqual(10_000);
    expect(work.recordReads).toBeLessThanOrEqual(100_000);
    expect(store.materializeBandOrder("content")).toEqual(ids);
    expect(ids.every((id, index) => store.get(id)?.bounds === initialBounds[index])).toBe(true);
    expect(model.revision).toBe(2);
    expect(history.canRedo).toBe(true);

    await expect(run("redo", () => history.redoAsync())).resolves.toBe(true);
    expect(work.recordReads).toBeGreaterThanOrEqual(10_000);
    expect(work.recordReads).toBeLessThanOrEqual(100_000);
    expect(store.size).toBe(0);
    expect(model.revision).toBe(3);
    expect(published).toHaveBeenCalledTimes(3);
    expect(history.commandCount).toBe(1);
    expect(history.canRedo).toBe(false);
  } finally {
    work.active = false;
    document.dispose();
    history.dispose();
    unsubscribe();
    scheduler.dispose();
  }
  expect(host.pendingFrames).toBe(0);
  expect(host.pendingTimers).toBe(0);
});

it(`advances terminal selection and Undo at ${profile.refreshRate} Hz beside budget-filling scene frames`, async () => {
  const { commit, host, prepare, prepared, registered, scheduler } = selectionUnderBusyScene();
  let sceneFrames = 0;
  const scene = () => {
    sceneFrames += 1;
    host.time += host.budget;
    scheduler.requestFrame(scene, "frame");
  };
  const input = vi.fn(() => expect(sceneFrames).toBe(0));
  scheduler.requestFrame(scene, "frame");
  scheduler.requestFrame(input, "input");
  scheduler.deadline();
  host.time = host.budget;
  const elements = Array.from({ length: 10_000 }, (_, index) => indexedStroke(index));
  expect(prepared.commitMove(elements, { x: 1, y: 1 })).toBe(true);

  await advanceBusyFrames(host, () => registered.undo !== undefined);
  if (registered.undo === undefined) throw new Error("Selection replacement did not commit.");
  const undoResult = registered.undo();
  await advanceBusyFrames(host, () => commit.mock.calls.length === 2);
  await expect(undoResult).resolves.toBe(true);
  expect(input).toHaveBeenCalledOnce();
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(sceneFrames).toBeGreaterThan(2);
  prepared.dispose();
  scheduler.dispose();
  expect(host.pendingFrames).toBe(0);
  expect(host.pendingTimers).toBe(0);
});

it(`posts a chunked export at ${profile.refreshRate} Hz beside budget-filling scene frames`, async () => {
  const host = new ManualHost();
  host.budget = profile.interruptibleSliceDeadlineMs;
  host.frameInterval = profile.frameDurationMs;
  const scheduler = new SharedFrameScheduler(host);
  const endpoint = new TestWorkerEndpoint();
  const client = new WorkerDocumentRuntimePort(() => endpoint, {
    workScheduler: scheduler,
    frameIntervalMilliseconds: () => host.frameInterval,
  });
  const scene = () => {
    host.time += host.budget;
    scheduler.requestFrame(scene, "frame");
  };
  scheduler.requestFrame(scene, "frame");
  scheduler.deadline();
  host.time = host.budget;
  const stroke = createTestStroke();
  const snapshot = createWorkerSnapshot(
    Array.from({ length: 10_000 }, (_, index) => ({
      ...stroke,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    })),
  );
  const exportPending = client.execute({
    baseModelRevision: null,
    exportGeneration: 1,
    modelRevision: snapshot.revision,
    sessionId: "session-a",
    snapshot,
    type: "export-full",
    workerEpoch: 1,
  });
  const backgroundPending = client.execute({
    identity: { operationId: 2, purpose: "verification", sessionId: "session-a", workerEpoch: 1 },
    input: "untrusted",
    type: "verify-output",
  });
  const sentRequests = () =>
    endpoint.sentMessages.filter(
      (message) => (message as { type?: string }).type === "inkbook-worker-request",
    );
  const wireFrames = await advanceBusyFrames(host, () => sentRequests().length > 0);
  expect(wireFrames).toBe(2);
  expect(sentRequests()).toHaveLength(1);
  const posted = sentRequests()[0] as {
    request: { snapshot: { elements: { records: unknown[] } }; type: string };
    type: string;
  };
  expect(posted.type).toBe("inkbook-worker-request");
  expect(posted.request.type).toBe("export-full-wire");
  expect(posted.request.snapshot.elements.records).toHaveLength(10_000);
  expect(endpoint.transfers[endpoint.transfers.length - 1]).toHaveLength(10_000);
  client.terminate();
  await expect(exportPending).rejects.toThrow("Document worker failed");
  await expect(backgroundPending).rejects.toThrow("Document worker failed");
  scheduler.dispose();
  expect(host.pendingFrames).toBe(0);
  expect(host.pendingTimers).toBe(0);
});
