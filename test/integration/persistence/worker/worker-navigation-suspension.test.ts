import { expect, it } from "vitest";
import {
  createSuspendedExportFixture,
  document,
  executor,
  exportRequest,
  identity,
} from "../../../fixtures/persistence/navigation-export";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { scenePathDeferred } from "../../../fixtures/persistence/scene-path-progress";
import { SessionScenePaths } from "../../../../src/obsidian/embeds/document-session/session-scene-paths";
import { AutosaveCoordinator } from "../../../../src/persistence/saving/autosave/coordinator";
import {
  AutosaveDocumentFixture,
  FakeClock,
  MemoryVault,
  serializeSnapshot,
} from "../saving/fixtures";

it.each([false, true])(
  "pauses a started export for navigation while visible and reserve contours finish with bridge=%s",
  async (bridge) => {
    const fixture = createSuspendedExportFixture(bridge);
    try {
      await fixture.synchronize();
      const completion: string[] = [];
      const exported = fixture.export().then((result) => {
        completion.push("export");
        return result;
      });
      await fixture.parked;
      expect(fixture.runtime.instrumentation.fragmentBuilds).toBe(1);
      fixture.port.setNavigationActive?.(true);
      const visible = fixture.prepare(1, false);
      fixture.release();
      expect((await visible).type).toBe("prepare-scene-paths-success");
      completion.push("visible");
      expect((await fixture.prepare(2, true)).type).toBe("prepare-scene-paths-success");
      completion.push("reserve");
      expect(completion).toEqual(["visible", "reserve"]);
      expect(fixture.runtime.instrumentation.fragmentBuilds).toBe(1);
      expect(fixture.runtime.instrumentation.shapeBuilds).toBe(3);
      expect(fixture.runtime.instrumentation.queuedJobs).toBe(1);
      expect(
        await fixture.port.execute({
          basisRevision: 1,
          identity: { ...identity, operationId: 10 },
          ids: [document.elements[0]!.id],
          type: "prepare-scene-paths",
        }),
      ).toMatchObject({ type: "runtime-failure", code: "basis-revision-mismatch" });
      expect(fixture.runtime.instrumentation.shapeBuilds).toBe(3);
      expect((await fixture.runtime.execute(exportRequest)).type).toBe("export-failure");
      fixture.port.setNavigationActive?.(false);
      expect((await exported).type).toBe("export-success");
      expect(completion).toEqual(["visible", "reserve", "export"]);
      expect(fixture.runtime.instrumentation.fragmentBuilds).toBe(3);
      expect(fixture.runtime.instrumentation.shapeBuilds).toBe(3);
      expect(fixture.runtime.instrumentation.queuedJobs).toBe(0);
    } finally {
      fixture.port.terminate();
      fixture.detach();
    }
    expect(fixture.runtime.instrumentation.retainedJobs).toBe(0);
    expect(fixture.runtime.instrumentation.shapeCacheBytes).toBe(0);
  },
);

it.each([false, true])(
  "keeps navigation contours admitted over nested speculative/export suspension with bridge=%s",
  async (bridge) => {
    const fixture = createSuspendedExportFixture(bridge);
    const published = scenePathDeferred();
    const acknowledgement = scenePathDeferred();
    try {
      await fixture.synchronize();
      const speculative = fixture.port.execute(
        {
          basisRevision: 0,
          identity: { ...identity, operationId: 20 },
          ids: [document.elements[0]!.id],
          speculative: true,
          streamProgress: true,
          type: "prepare-scene-paths",
        },
        {
          unlockBatch: () => undefined,
          scenePaths: () => {
            published.resolve();
            return acknowledgement.promise;
          },
        },
      );
      await published.promise;
      const exported = fixture.export();
      await fixture.parked;
      fixture.port.setNavigationActive?.(true);
      const visible = fixture.prepare(1, false);
      fixture.release();
      expect((await visible).type).toBe("prepare-scene-paths-success");
      expect(fixture.runtime.instrumentation.fragmentBuilds).toBe(1);
      expect(fixture.runtime.instrumentation.queuedJobs).toBe(2);
      fixture.port.setNavigationActive?.(false);
      expect((await exported).type).toBe("export-success");
      expect((await speculative).type).toBe("runtime-failure");
      expect(fixture.runtime.instrumentation.queuedJobs).toBe(0);
      expect(fixture.runtime.instrumentation.retainedJobs).toBe(0);
    } finally {
      acknowledgement.resolve();
      fixture.port.terminate();
      fixture.detach();
    }
  },
);

it.each([false, true])(
  "releases a navigation-suspended export on termination with bridge=%s",
  async (bridge) => {
    const fixture = createSuspendedExportFixture(bridge);
    await fixture.synchronize();
    const exported = fixture.export().catch((error: unknown) => error);
    await fixture.parked;
    fixture.port.setNavigationActive?.(true);
    const visible = fixture.prepare(1, false);
    fixture.release();
    await visible;
    expect(fixture.runtime.instrumentation.fragmentBuilds).toBe(1);
    fixture.port.terminate();
    fixture.detach();
    expect(await exported).toBeInstanceOf(Error);
    expect(fixture.runtime.instrumentation.retainedJobs).toBe(0);
    expect(fixture.runtime.instrumentation.queuedJobs).toBe(0);
    expect(fixture.runtime.instrumentation.shapeCacheBytes).toBe(0);
  },
);

it.each([false, true])(
  "preserves current scene demand and fails over newer demand during a suspended autosave with bridge=%s",
  async (bridge) => {
    const fixture = createSuspendedExportFixture(bridge);
    const session = createAutosaveSceneFixture(fixture);
    try {
      await fixture.synchronize();
      session.commitPage(1);
      expect(await session.paths.prepare([], new AbortController().signal)).toEqual([]);
      const saved = session.coordinator.flush("lock");
      await fixture.parked;
      fixture.port.setNavigationActive?.(true);
      session.document.gestureActive = true;
      const visible = session.paths.prepare(
        [document.elements[1]!.id],
        new AbortController().signal,
      );
      fixture.release();
      expect(await visible).toHaveLength(1);
      expect(fixture.runtime.instrumentation.fragmentBuilds).toBe(1);
      expect(fixture.runtime.instrumentation.shapeBuilds).toBe(2);
      session.commitPage(2);
      expect(
        await session.paths.prepare([document.elements[2]!.id], new AbortController().signal),
      ).toBeUndefined();
      expect(fixture.runtime.instrumentation.fragmentBuilds).toBe(1);
      expect(fixture.runtime.instrumentation.shapeBuilds).toBe(2);
      expect(fixture.runtime.instrumentation.retainedJobs).toBe(1);
      session.document.gestureActive = false;
      fixture.port.setNavigationActive?.(false);
      session.clock.advance(1_000);
      expect(await saved).toBe("clean");
      expect(session.vault.processCount).toBe(1);
      expect(session.vault.content).toContain('data-inkbook-revision="2"');
      expect(
        await session.paths.prepare([document.elements[2]!.id], new AbortController().signal),
      ).toHaveLength(1);
      expect(fixture.runtime.instrumentation.shapeBuilds).toBe(3);
      expect(fixture.runtime.instrumentation.fragmentBuilds).toBe(3);
    } finally {
      session.coordinator.dispose();
      fixture.detach();
    }
  },
);

function createAutosaveSceneFixture(fixture: ReturnType<typeof createSuspendedExportFixture>) {
  const initial = serializeSnapshot(document);
  const value = new AutosaveDocumentFixture();
  value.value = document;
  const vault = new MemoryVault(initial.svg);
  const clock = new FakeClock();
  const coordinator = new AutosaveCoordinator({
    workScheduler: new TestWorkScheduler(),
    clock,
    documentSource: value,
    confirmedBase: { type: "confirmed", revision: 0, outputHash: initial.hash },
    executor: fixture.port,
    initialSnapshot: document,
    path: "navigation.svg",
    sessionId: executor.sessionId,
    vault,
    workerEpoch: executor.workerEpoch,
  });
  const paths = new SessionScenePaths({
    disposed: () => false,
    executor: () => fixture.port,
    revision: () => value.currentRevision(),
    sessionId: executor.sessionId,
    synchronize: (candidate) => coordinator.synchronizeWorkerBaseline(candidate),
    workerEpoch: () => executor.workerEpoch,
  });
  return {
    clock,
    coordinator,
    document: value,
    paths,
    vault,
    commitPage: (revision: number) => {
      value.commitPage(revision, { ...value.value.page, lockedBufferLines: revision + 1 });
      coordinator.recordCommit({ modelRevision: revision, page: value.value.page });
    },
  };
}
