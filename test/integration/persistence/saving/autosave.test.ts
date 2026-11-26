import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { describe, expect, it } from "vitest";

import { AutosaveCoordinator } from "../../../../src/persistence/saving/autosave/public";
import { DocumentWorkerRuntime } from "../../../../src/persistence/worker/runtime/public";
import type { DocumentRuntimePort } from "../../../../src/persistence/worker/runtime/public";
import { rectangle } from "../../../unit/persistence/worker/runtime/fixtures";
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
    initialRevision: 0,
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
});
