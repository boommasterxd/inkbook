import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { describe, expect, it } from "vitest";

import { FILE_SCHEMA_LIMITS } from "../../../../src/domain/schema/constants";
import { deriveDocumentIntegrityManifest } from "../../../../src/persistence/serialization/public";
import { sha256Hex } from "../../../../src/persistence/serialization/sha256";
import { AutosaveCoordinator } from "../../../../src/persistence/saving/autosave/public";
import { DocumentWorkerRuntime } from "../../../../src/persistence/worker/runtime/public";
import type {
  DocumentRuntimePort,
  DocumentRuntimeRequest,
} from "../../../../src/persistence/worker/runtime/public";
import { rectangle, snapshot } from "../../../unit/persistence/worker/runtime/fixtures";
import { AutosaveDocumentFixture, FakeClock, MemoryVault, serializeSnapshot } from "./fixtures";

interface Harness {
  readonly clock: FakeClock;
  readonly coordinator: AutosaveCoordinator;
  readonly documentSource: AutosaveDocumentFixture;
  readonly initial: ReturnType<typeof serializeSnapshot>;
  readonly vault: MemoryVault;
}

async function createHarness(
  options: {
    readonly gesture?: boolean;
    readonly vaultContent?: string;
  } = {},
): Promise<Harness> {
  const initial = serializeSnapshot();
  const executor = new DocumentWorkerRuntime({ sessionId: "session-a", workerEpoch: 1 });
  await executor.execute({
    identity: {
      operationId: 1,
      purpose: "unlock",
      sessionId: "session-a",
      workerEpoch: 1,
    },
    input: initial.svg,
    type: "unlock",
  });
  const clock = new FakeClock();
  const documentSource = new AutosaveDocumentFixture();
  documentSource.gestureActive = options.gesture ?? false;
  const vault = new MemoryVault(options.vaultContent ?? initial.svg);
  const coordinator = createCoordinator({ clock, documentSource, initial, vault }, executor);
  return { clock, coordinator, documentSource, initial, vault };
}

function createCoordinator(
  harness: Omit<Harness, "coordinator">,
  executor: DocumentRuntimePort,
  createFallback?: (workerEpoch: number) => DocumentRuntimePort,
): AutosaveCoordinator {
  const coordinator = new AutosaveCoordinator({
    workScheduler: createTestWorkScheduler(),
    clock: harness.clock,
    confirmedBase: { outputHash: harness.initial.hash, revision: 0, type: "confirmed" },
    ...(createFallback === undefined ? {} : { createFallback }),
    documentSource: harness.documentSource,
    executor,
    initialSnapshot: snapshot(),
    path: "drawing.svg",
    sessionId: "session-a",
    vault: harness.vault,
    workerEpoch: 1,
  });
  return coordinator;
}

function recordRectangleCommit(harness: Harness, revision: number, x: number): void {
  harness.documentSource.commit(revision, x);
  harness.coordinator.recordCommit({
    changedElements: [rectangle(x)],
    modelRevision: revision,
  });
}

it.each([false, true])(
  "settles only the current save operation with indeterminate result %s",
  async (indeterminate) => {
    const harness = await createHarness();
    expect(harness.coordinator.currentSaveSettlement).toBeUndefined();
    let release!: () => void;
    harness.vault.processGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.vault.failAfterWrite = indeterminate;
    recordRectangleCommit(harness, 1, 170);
    const flush = harness.coordinator.flush("detach");
    await harness.vault.waitForProcessCount(1);
    const settlement = harness.coordinator.currentSaveSettlement;
    expect(settlement).toBeInstanceOf(Promise);
    release();
    await settlement;
    await expect(flush).resolves.toBe(indeterminate ? "verification-required" : "clean");
    expect(harness.coordinator.currentSaveSettlement).toBeUndefined();
    expect(harness.coordinator.dirty).toBe(indeterminate);
  },
);

describe("autosave trust boundaries", () => {
  it("ignores a delayed notification for the confirmed base when a local commit wins the race", async () => {
    const harness = await createHarness();
    let releaseRead = (): void => undefined;
    harness.vault.readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const notification = harness.coordinator.notifyExternalChange();
    await harness.vault.waitForReadCount(1);

    recordRectangleCommit(harness, 1, 135);
    harness.vault.readGate = null;
    releaseRead();

    await expect(notification).resolves.toBe("unchanged");
    expect(harness.coordinator.status).toBe("debouncing");
    expect(harness.coordinator.dirty).toBe(true);
  });

  it("distinguishes unchanged host content from a dirty external conflict", async () => {
    const unchanged = await createHarness();
    recordRectangleCommit(unchanged, 1, 136);

    await expect(unchanged.coordinator.notifyExternalChange()).resolves.toBe("unchanged");
    expect(unchanged.coordinator.status).toBe("debouncing");
    expect(unchanged.coordinator.dirty).toBe(true);

    const changed = await createHarness();
    recordRectangleCommit(changed, 1, 137);
    changed.vault.content = serializeSnapshot({ ...snapshot(), revision: 12 }).svg;

    await expect(changed.coordinator.notifyExternalChange()).resolves.toBe("conflict");
    expect(changed.coordinator.status).toBe("conflict");
    expect(changed.coordinator.dirty).toBe(true);
  });

  it("ignores a notification for an indeterminate write that matches the active save proof", async () => {
    const harness = await createHarness();
    harness.vault.failAfterWrite = true;
    recordRectangleCommit(harness, 1, 138);

    await expect(harness.coordinator.flush("retry")).resolves.toBe("verification-required");
    await expect(harness.coordinator.notifyExternalChange()).resolves.toBe("unchanged");
    expect(harness.coordinator.status).toBe("verification-required");
    expect(harness.coordinator.dirty).toBe(true);
  });

  it("cleans up a malformed UTF-8 export without hanging flush waiters or writing", async () => {
    const harness = await createHarness();
    const invalid = new Uint8Array([0x61, 0xf0, 0x9f, 0x99]);
    const executor: DocumentRuntimePort = {
      execute: async (request: DocumentRuntimeRequest) => {
        if (request.type !== "export-full" && request.type !== "export-incremental") {
          throw new Error("Unexpected request.");
        }
        return {
          exportGeneration: request.exportGeneration,
          integrityManifest: deriveDocumentIntegrityManifest(harness.documentSource.snapshot()),
          modelRevision: request.modelRevision,
          output: invalid,
          outputHash: sha256Hex(invalid),
          sessionId: request.sessionId,
          type: "export-success",
          workerEpoch: request.workerEpoch,
        };
      },
      terminate: () => undefined,
    };
    const coordinator = createCoordinator(harness, executor);
    harness.documentSource.commit(1, 136);
    coordinator.recordCommit({ changedElements: [rectangle(136)], modelRevision: 1 });

    await expect(coordinator.flush("retry")).resolves.toBe("executor-failed");
    expect(harness.vault.processCount).toBe(0);
    expect(coordinator.dirty).toBe(true);
  });
});

describe("automatic autosave scheduling", () => {
  it("debounces content commits for 1,000 ms and confirms the read-back", async () => {
    const harness = await createHarness();
    recordRectangleCommit(harness, 1, 140);

    harness.clock.advance(999);
    expect(harness.vault.processCount).toBe(0);
    harness.clock.advance(1);

    await expectAutomaticSave(harness);
  });

  it("rechecks every 200 ms without dispatching while a gesture is active", async () => {
    const harness = await createHarness({ gesture: true });
    recordRectangleCommit(harness, 1, 150);

    harness.clock.advance(1_000);
    expect(harness.vault.processCount).toBe(0);
    harness.documentSource.gestureActive = false;
    harness.clock.advance(199);
    expect(harness.vault.processCount).toBe(0);
    harness.clock.advance(1);

    await expectAutomaticSave(harness);
  });
});

describe("autosave conflicts and read-back recovery", () => {
  it("suspends on an exact-base conflict without overwriting external content", async () => {
    const harness = await createHarness({ vaultContent: "external-version" });
    recordRectangleCommit(harness, 1, 160);

    await expect(harness.coordinator.flush("retry")).resolves.toBe("conflict");
    expect(harness.vault.content).toBe("external-version");
    expect(harness.vault.processCount).toBe(0);
  });

  it("proves an indeterminate post-write result before clearing dirty state", async () => {
    const harness = await createHarness();
    harness.vault.failAfterWrite = true;
    recordRectangleCommit(harness, 1, 170);

    await expect(harness.coordinator.flush("detach")).resolves.toBe("verification-required");
    expect(harness.coordinator.dirty).toBe(true);
    expect(harness.vault.processCount).toBe(1);

    harness.vault.failAfterWrite = false;
    await expect(harness.coordinator.retryVerification()).resolves.toBe("clean");
    expect(harness.vault.processCount).toBe(1);
    expect(harness.coordinator.dirty).toBe(false);
  });

  it("loads and verifies the confirmed content lazily without a duplicate preflight read", async () => {
    const harness = await createHarness();
    recordRectangleCommit(harness, 1, 175);

    await expect(harness.coordinator.flush("retry")).resolves.toBe("clean");
    expect(harness.vault.processCount).toBe(1);
    expect(harness.vault.readCount).toBe(2);
  });

  it("suspends without reading when lazy expected-base content is oversized", async () => {
    const harness = await createHarness();
    harness.vault.reportedSize = FILE_SCHEMA_LIMITS.totalInputBytes + 1;
    recordRectangleCommit(harness, 1, 176);

    await expect(harness.coordinator.flush("retry")).resolves.toBe("verification-required");
    expect(harness.coordinator.dirty).toBe(true);
    expect(harness.vault.readCount).toBe(0);
    expect(harness.vault.processCount).toBe(0);
  });

  it("keeps a completed write indeterminate when its read-back becomes oversized", async () => {
    const harness = await createHarness();
    harness.vault.oversizedAfterWrite = true;
    recordRectangleCommit(harness, 1, 177);

    await expect(harness.coordinator.flush("retry")).resolves.toBe("verification-required");
    expect(harness.coordinator.dirty).toBe(true);
    expect(harness.vault.processCount).toBe(1);
    expect(harness.vault.readCount).toBe(1);
  });

  it("keeps an indeterminate write pending when retry verification is oversized", async () => {
    const harness = await createHarness();
    harness.vault.failAfterWrite = true;
    recordRectangleCommit(harness, 1, 178);
    await expect(harness.coordinator.flush("retry")).resolves.toBe("verification-required");
    const readsBeforeRetry = harness.vault.readCount;
    harness.vault.reportedSize = FILE_SCHEMA_LIMITS.totalInputBytes + 1;

    await expect(harness.coordinator.retryVerification()).resolves.toBe("verification-required");
    expect(harness.coordinator.dirty).toBe(true);
    expect(harness.vault.readCount).toBe(readsBeforeRetry);
    expect(harness.vault.processCount).toBe(1);
  });
});

describe("autosave backpressure and recovery", () => {
  it("rejects a stale started save and writes its coalesced successor without starvation", async () => {
    const harness = await createHarness();
    let releaseFirstWrite = (): void => undefined;
    harness.vault.processGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    recordRectangleCommit(harness, 1, 180);
    const firstProcess = harness.vault.waitForProcessCount(1);
    const flush = harness.coordinator.flush("retry");
    await firstProcess;
    expect(harness.vault.processCount).toBe(1);

    recordRectangleCommit(harness, 2, 220);
    harness.clock.advance(1_000);
    expect(harness.vault.processCount).toBe(1);

    harness.vault.processGate = null;
    releaseFirstWrite();
    await expect(flush).resolves.toBe("clean");
    expect(harness.vault.processCount).toBe(2);
    const persisted = serializeSnapshot(harness.documentSource.value);
    expect(harness.vault.writtenContents).toEqual([persisted.svg]);
    expect(harness.vault.content).toBe(persisted.svg);
  });

  it("switches once to a new-epoch fallback and retries with a full snapshot", async () => {
    const harness = await createHarness();
    const failingExecutor = {
      execute: async () => Promise.reject(new Error("worker crashed")),
      terminate: () => undefined,
    };
    let fallbackCreations = 0;
    const coordinator = createCoordinator(harness, failingExecutor, (workerEpoch) => {
      fallbackCreations += 1;
      return new DocumentWorkerRuntime({ sessionId: "session-a", workerEpoch });
    });
    harness.documentSource.commit(1, 180);
    coordinator.recordCommit({ changedElements: [rectangle(180)], modelRevision: 1 });

    await expect(coordinator.flush("retry")).resolves.toBe("clean");
    expect(fallbackCreations).toBe(1);
    expect(harness.vault.processCount).toBe(1);
  });
});

describe("autosave verification executor recovery", () => {
  it("recovers unknown-base verification under a new epoch without overwriting external changes", async () => {
    const harness = await createHarness();
    const primary = new DocumentWorkerRuntime({ sessionId: "session-a", workerEpoch: 1 });
    await primary.execute({
      identity: {
        operationId: 1,
        purpose: "unlock",
        sessionId: "session-a",
        workerEpoch: 1,
      },
      input: harness.initial.svg,
      type: "unlock",
    });
    harness.vault.content += "\n";
    let failVerification = true;
    const executor: DocumentRuntimePort = {
      execute: (request, observer) => {
        if (request.type === "verify-output" && failVerification) {
          failVerification = false;
          return Promise.reject(new Error("worker crashed during preflight"));
        }
        return primary.execute(request, observer);
      },
      terminate: () => primary.terminate(),
    };
    let fallbackCreations = 0;
    const fallbackRequests: string[] = [];
    const coordinator = createCoordinator(harness, executor, (workerEpoch) => {
      fallbackCreations += 1;
      const fallback = new DocumentWorkerRuntime({ sessionId: "session-a", workerEpoch });
      return {
        execute: (request, observer) => {
          fallbackRequests.push(request.type);
          return fallback.execute(request, observer);
        },
        terminate: () => fallback.terminate(),
      };
    });
    harness.documentSource.commit(1, 200);
    coordinator.recordCommit({ changedElements: [rectangle(200)], modelRevision: 1 });

    await expect(coordinator.flush("retry")).resolves.toBe("conflict");
    expect(fallbackRequests).toEqual(["verify-output"]);
    expect(fallbackCreations).toBe(1);
    expect(harness.vault.processCount).toBe(0);
    expect(harness.vault.content).toBe(harness.initial.svg + "\n");
  });
});

async function expectAutomaticSave(
  harness: Awaited<ReturnType<typeof createHarness>>,
): Promise<void> {
  await harness.vault.waitForProcessCount(1);
  await harness.coordinator.currentSaveSettlement;
  expect(harness.vault.processCount).toBe(1);
  expect(harness.coordinator.dirty).toBe(false);
  expect(harness.vault.content).toBe(serializeSnapshot(harness.documentSource.value).svg);
}
