import { describe, expect, it } from "vitest";

import { FILE_SCHEMA_LIMITS } from "../../../../src/domain/schema/constants";
import { sha256Hex } from "../../../../src/persistence/serialization/public";
import {
  AutosaveCoordinator,
  type AutosaveClock,
} from "../../../../src/persistence/saving/autosave/public";
import type { MetadataGuardedFileRead } from "../../../../src/persistence/saving/save-ports";
import { DocumentWorkerRuntime } from "../../../../src/persistence/worker/runtime/public";
import type {
  DocumentRuntimePort,
  DocumentRuntimeRequest,
} from "../../../../src/persistence/worker/runtime/public";
import { rectangle, snapshot } from "../../../unit/persistence/worker/runtime/fixtures";
import { AutosaveDocumentFixture, serializeSnapshot } from "./fixtures";

interface TimerEntry {
  readonly callback: () => void;
  readonly due: number;
  readonly id: number;
}

class FakeClock implements AutosaveClock {
  #now = 0;
  #nextId = 0;
  readonly #timers = new Map<number, TimerEntry>();

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  setTimeout(callback: () => void, milliseconds: number): unknown {
    const id = ++this.#nextId;
    this.#timers.set(id, { callback, due: this.#now + milliseconds, id });
    return id;
  }

  advance(milliseconds: number): void {
    this.#now += milliseconds;
    while (true) {
      const next = [...this.#timers.values()]
        .filter(({ due }) => due <= this.#now)
        .sort((left, right) => left.due - right.due || left.id - right.id)[0];
      if (next === undefined) return;
      this.#timers.delete(next.id);
      next.callback();
    }
  }
}

class MemoryVault {
  content: string;
  processCount = 0;
  readCount = 0;
  readonly writtenContents: string[] = [];
  reportedSize: number | null = null;
  oversizedAfterWrite = false;
  failAfterWrite = false;
  processGate: Promise<void> | null = null;
  readGate: Promise<void> | null = null;
  readonly #processWaiters = new Set<{ readonly count: number; readonly resolve: () => void }>();
  readonly #readWaiters = new Set<{ readonly count: number; readonly resolve: () => void }>();

  public constructor(content: string) {
    this.content = content;
  }

  async create(_path: string, content: string): Promise<void> {
    this.content = content;
  }

  async process(_path: string, update: (current: string) => string): Promise<string> {
    this.processCount += 1;
    for (const waiter of this.#processWaiters) {
      if (this.processCount < waiter.count) continue;
      this.#processWaiters.delete(waiter);
      waiter.resolve();
    }
    if (this.processGate !== null) await this.processGate;
    this.content = update(this.content);
    this.writtenContents.push(this.content);
    if (this.failAfterWrite) throw new Error("indeterminate");
    return this.content;
  }

  async read(): Promise<string> {
    this.readCount += 1;
    for (const waiter of this.#readWaiters) {
      if (this.readCount < waiter.count) continue;
      this.#readWaiters.delete(waiter);
      waiter.resolve();
    }
    if (this.readGate !== null) await this.readGate;
    return this.content;
  }

  async readWithMetadataGuard(
    path: string,
    maximumBytes: number,
  ): Promise<MetadataGuardedFileRead> {
    const size = await this.size();
    if (size > maximumBytes) throw new RangeError("The vault file exceeds the input byte limit.");
    const content = await this.read();
    return {
      content,
      identity: { ctime: 1, mtime: 1, path, size },
      materialization: "host-full-read-not-bounded",
      stabilityEvidence: "object-identity-and-stat-unchanged",
    };
  }

  async size(): Promise<number> {
    if (this.reportedSize !== null) return this.reportedSize;
    if (this.oversizedAfterWrite && this.processCount > 0) {
      return FILE_SCHEMA_LIMITS.totalInputBytes + 1;
    }
    return new TextEncoder().encode(this.content).byteLength;
  }

  waitForProcessCount(count: number): Promise<void> {
    if (this.processCount >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.#processWaiters.add({ count, resolve });
    });
  }

  waitForReadCount(count: number): Promise<void> {
    if (this.readCount >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.#readWaiters.add({ count, resolve });
    });
  }
}

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
    readonly lazyConfirmedContent?: boolean;
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
  const coordinator = new AutosaveCoordinator({
    clock,
    confirmedBase: { outputHash: initial.hash, revision: 0, type: "confirmed" },
    ...(options.lazyConfirmedContent ? {} : { confirmedContent: initial.svg }),
    documentSource,
    executor,
    initialSnapshot: snapshot(),
    path: "drawing.svg",
    sessionId: "session-a",
    vault,
    workerEpoch: 1,
  });
  return { clock, coordinator, documentSource, initial, vault };
}

function recordRectangleCommit(harness: Harness, revision: number, x: number): void {
  harness.documentSource.commit(revision, x);
  harness.coordinator.recordCommit({
    changedElements: [rectangle(x)],
    modelRevision: revision,
  });
}

describe("autosave trust boundaries", () => {
  it("rejects external-change adoption when a local commit wins the asynchronous race", async () => {
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

    await expect(notification).resolves.toBe("conflict");
    expect(harness.coordinator.status).toBe("conflict");
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
    const coordinator = new AutosaveCoordinator({
      clock: harness.clock,
      confirmedBase: { outputHash: harness.initial.hash, revision: 0, type: "confirmed" },
      confirmedContent: harness.initial.svg,
      documentSource: harness.documentSource,
      executor,
      initialSnapshot: snapshot(),
      path: "drawing.svg",
      sessionId: "session-a",
      vault: harness.vault,
      workerEpoch: 1,
    });
    harness.documentSource.commit(1, 136);
    coordinator.recordCommit({ changedElements: [rectangle(136)], modelRevision: 1 });

    await expect(coordinator.flush("retry")).resolves.toBe("executor-failed");
    expect(harness.vault.processCount).toBe(0);
    expect(coordinator.dirty).toBe(true);
  });
});

describe("autosave orchestration", () => {
  it("debounces content commits for 500 ms and confirms the read-back", async () => {
    const harness = await createHarness();
    recordRectangleCommit(harness, 1, 140);

    harness.clock.advance(499);
    expect(harness.vault.processCount).toBe(0);
    harness.clock.advance(1);

    await expect(harness.coordinator.flush("retry")).resolves.toBe("clean");
    expect(harness.vault.processCount).toBe(1);
    expect(harness.coordinator.dirty).toBe(false);
    expect(harness.coordinator.retainedConfirmedContentBytes).toBe(0);
  });

  it("rechecks every 200 ms without dispatching while a gesture is active", async () => {
    const harness = await createHarness({ gesture: true });
    recordRectangleCommit(harness, 1, 150);

    harness.clock.advance(500);
    expect(harness.vault.processCount).toBe(0);
    harness.documentSource.gestureActive = false;
    harness.clock.advance(199);
    expect(harness.vault.processCount).toBe(0);
    harness.clock.advance(1);

    await expect(harness.coordinator.flush("lock")).resolves.toBe("clean");
    expect(harness.vault.processCount).toBe(1);
  });

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
    const harness = await createHarness({ lazyConfirmedContent: true });
    recordRectangleCommit(harness, 1, 175);

    await expect(harness.coordinator.flush("retry")).resolves.toBe("clean");
    expect(harness.vault.processCount).toBe(1);
    expect(harness.vault.readCount).toBe(2);
  });

  it("suspends without reading when lazy expected-base content is oversized", async () => {
    const harness = await createHarness({ lazyConfirmedContent: true });
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
    harness.clock.advance(500);
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
    const coordinator = new AutosaveCoordinator({
      clock: harness.clock,
      confirmedBase: { outputHash: harness.initial.hash, revision: 0, type: "confirmed" },
      confirmedContent: harness.initial.svg,
      createFallback: (workerEpoch) => {
        fallbackCreations += 1;
        return new DocumentWorkerRuntime({ sessionId: "session-a", workerEpoch });
      },
      documentSource: harness.documentSource,
      executor: failingExecutor,
      initialSnapshot: snapshot(),
      path: "drawing.svg",
      sessionId: "session-a",
      vault: harness.vault,
      workerEpoch: 1,
    });
    harness.documentSource.commit(1, 180);
    coordinator.recordCommit({ changedElements: [rectangle(180)], modelRevision: 1 });

    await expect(coordinator.flush("retry")).resolves.toBe("clean");
    expect(fallbackCreations).toBe(1);
    expect(harness.vault.processCount).toBe(1);
  });
});

describe("autosave verification executor recovery", () => {
  it("retries failed preflight verification under the new executor epoch", async () => {
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
    const coordinator = new AutosaveCoordinator({
      clock: harness.clock,
      confirmedBase: { outputHash: harness.initial.hash, revision: 0, type: "confirmed" },
      createFallback: (workerEpoch) => {
        fallbackCreations += 1;
        const fallback = new DocumentWorkerRuntime({ sessionId: "session-a", workerEpoch });
        return {
          execute: (request, observer) => {
            fallbackRequests.push(request.type);
            return fallback.execute(request, observer);
          },
          terminate: () => fallback.terminate(),
        };
      },
      documentSource: harness.documentSource,
      executor,
      initialSnapshot: snapshot(),
      path: "drawing.svg",
      sessionId: "session-a",
      vault: harness.vault,
      workerEpoch: 1,
    });
    harness.documentSource.commit(1, 200);
    coordinator.recordCommit({ changedElements: [rectangle(200)], modelRevision: 1 });

    await expect(coordinator.flush("retry")).resolves.toBe("clean");
    expect(fallbackRequests).toEqual(["verify-output"]);
    expect(fallbackCreations).toBe(1);
    expect(harness.vault.processCount).toBe(1);
  });
});
