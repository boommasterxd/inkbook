import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { describe, expect, it, vi } from "vitest";

import { AutosaveCoordinator } from "../../../../src/persistence/saving/autosave/public";
import type { MetadataGuardedFileRead } from "../../../../src/persistence/saving/save-ports";
import {
  DocumentWorkerRuntime,
  type DocumentRuntimePort,
} from "../../../../src/persistence/worker/runtime/public";
import { rectangle, snapshot } from "../../../unit/persistence/worker/runtime/fixtures";
import { AutosaveDocumentFixture, serializeSnapshot } from "./fixtures";

class IntegrityVault {
  content: string;
  processCount = 0;
  readonly writtenContents: string[] = [];

  public constructor(content: string) {
    this.content = content;
  }

  public async process(_path: string, update: (current: string) => string): Promise<string> {
    this.processCount += 1;
    this.content = update(this.content);
    this.writtenContents.push(this.content);
    return this.content;
  }

  public async readWithMetadataGuard(path: string): Promise<MetadataGuardedFileRead> {
    return {
      content: this.content,
      identity: { ctime: 1, mtime: 1, path, size: this.content.length },
      materialization: "host-full-read-not-bounded",
      stabilityEvidence: "object-identity-and-stat-unchanged",
    };
  }
}

describe("autosave Store-to-worker integrity", () => {
  it("rebuilds the worker once from a full Store snapshot before persisting", async () => {
    const exportTypes: string[] = [];
    let remainingMismatches = 1;
    const harness = await createHarness((runtime) =>
      tamperingExecutor(runtime, exportTypes, () => remainingMismatches-- > 0),
    );
    commit(harness, 134);

    await expect(harness.coordinator.flush("retry")).resolves.toBe("clean");

    expect(exportTypes).toEqual(["export-incremental", "export-full"]);
    expect(harness.vault.processCount).toBe(1);
  });

  it("fails closed when the full-snapshot export still diverges", async () => {
    const exportTypes: string[] = [];
    const harness = await createHarness((runtime) =>
      tamperingExecutor(runtime, exportTypes, () => true),
    );
    commit(harness, 135);

    await expect(harness.coordinator.flush("retry")).resolves.toBe("executor-failed");

    expect(exportTypes).toEqual(["export-incremental", "export-full"]);
    expect(harness.vault.processCount).toBe(0);
    expect(harness.vault.writtenContents).toEqual([]);
  });

  it("rejects SVG bytes whose snapshot digest does not match the verified manifest", async () => {
    const wrongOutput = serializeSnapshot(snapshot(1, 999));
    const harness = await createHarness((runtime) => ({
      acknowledgeExport: (identity, accepted) => runtime.acknowledgeExport(identity, accepted),
      execute: async (request, observer) => {
        const result = await runtime.execute(request, observer);
        return result.type === "export-success"
          ? { ...result, output: wrongOutput.svg, outputHash: wrongOutput.hash }
          : result;
      },
      requestPrewarm: () => runtime.requestPrewarm(),
      setLiveInputActive: (active) => runtime.setLiveInputActive(active),
      terminate: () => runtime.terminate(),
    }));
    commit(harness, 136);

    await expect(harness.coordinator.flush("retry")).resolves.toBe("executor-failed");

    expect(harness.vault.processCount).toBe(0);
    expect(harness.vault.writtenContents).toEqual([]);
  });
});

async function createHarness(
  wrap: (runtime: DocumentWorkerRuntime) => DocumentRuntimePort,
): Promise<{
  readonly coordinator: AutosaveCoordinator;
  readonly document: AutosaveDocumentFixture;
  readonly vault: IntegrityVault;
}> {
  const initial = serializeSnapshot();
  const runtime = new DocumentWorkerRuntime({ sessionId: "session-a", workerEpoch: 1 });
  await runtime.execute({
    identity: { operationId: 1, purpose: "unlock", sessionId: "session-a", workerEpoch: 1 },
    input: initial.svg,
    type: "unlock",
  });
  const document = new AutosaveDocumentFixture();
  const vault = new IntegrityVault(initial.svg);
  const coordinator = new AutosaveCoordinator({
    workScheduler: createTestWorkScheduler(),
    clock: { clearTimeout: vi.fn(), setTimeout: vi.fn() },
    confirmedBase: { outputHash: initial.hash, revision: 0, type: "confirmed" },
    confirmedContent: initial.svg,
    documentSource: document,
    executor: wrap(runtime),
    initialSnapshot: snapshot(),
    path: "drawing.svg",
    sessionId: "session-a",
    vault,
    workerEpoch: 1,
  });
  return { coordinator, document, vault };
}

function tamperingExecutor(
  runtime: DocumentWorkerRuntime,
  exportTypes: string[],
  shouldTamper: () => boolean,
): DocumentRuntimePort {
  return {
    acknowledgeExport: (identity, accepted) => runtime.acknowledgeExport(identity, accepted),
    execute: async (request, observer) => {
      const result = await runtime.execute(request, observer);
      if (result.type !== "export-success") return result;
      exportTypes.push(request.type);
      return shouldTamper()
        ? {
            ...result,
            integrityManifest: { ...result.integrityManifest, contentDigest: "0".repeat(64) },
          }
        : result;
    },
    requestPrewarm: () => runtime.requestPrewarm(),
    setLiveInputActive: (active) => runtime.setLiveInputActive(active),
    terminate: () => runtime.terminate(),
  };
}

function commit(harness: Awaited<ReturnType<typeof createHarness>>, x: number): void {
  harness.document.commit(1, x);
  harness.coordinator.recordCommit({ changedElements: [rectangle(x)], modelRevision: 1 });
}
