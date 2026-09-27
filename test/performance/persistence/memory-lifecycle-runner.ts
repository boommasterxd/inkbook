import { createTestWorkScheduler } from "../../fixtures/persistence/work-scheduler";
import type { InkElementV1, InkSnapshotV1, PageV1 } from "../../../src/domain/schema/public";
import { CoalescedExportTarget } from "../../../src/persistence/worker/coalesced-export";
import type { ExportSuccess } from "../../../src/persistence/worker/protocol";
import { createProductionDocumentRuntime } from "../../../src/persistence/worker/runtime/production-document-runtime";
import {
  decodeRuntimeResultChunked,
  encodeRuntimeResultChunked,
} from "../../../src/persistence/worker/runtime/wire-codec";
import type { DocumentWorkerRuntime } from "../../../src/persistence/worker/runtime/public";
import { createStandardPersistenceFixture, replaceFirstStroke } from "./fixtures";
import type { MemoryCheckpoint, ReleasedInstrumentation } from "./memory-lifecycle-contract";

const COALESCED_COMMITS = 5;
const LIFECYCLE_RUNS = 5;
const SESSION_ID = "memory-performance";
const WORKER_EPOCH = 1;

interface LifecycleResult {
  readonly cacheBytes: number;
  readonly cacheElements: number;
  readonly outputBytes: number;
  readonly released: ReleasedInstrumentation;
}

async function main(): Promise<void> {
  requireGarbageCollector();
  await stabilizeGarbageCollection();
  await runLifecycle(0, liveHeapBytes(), []);
  await stabilizeGarbageCollection();
  const baseline = liveHeapBytes();
  const checkpoints: MemoryCheckpoint[] = [];
  const retainedBytes: number[] = [];
  const runs: LifecycleResult[] = [];
  for (let run = 1; run <= LIFECYCLE_RUNS; run += 1) {
    runs.push(await runLifecycle(run, baseline, checkpoints));
    await stabilizeGarbageCollection();
    retainedBytes.push(additionalBytes(baseline));
  }
  process.stdout.write(
    `${JSON.stringify({
      cacheBytes: Math.max(...runs.map(({ cacheBytes }) => cacheBytes)),
      cacheElements: Math.max(...runs.map(({ cacheElements }) => cacheElements)),
      checkpoints,
      coalescedCommitsPerRun: COALESCED_COMMITS,
      lifecycleRuns: LIFECYCLE_RUNS,
      outputBytes: Math.max(...runs.map(({ outputBytes }) => outputBytes)),
      peakBytes: Math.max(...checkpoints.map(({ bytes }) => bytes)),
      releasedInstrumentation: runs.map(({ released }) => released),
      retainedBytes,
    })}\n`,
  );
}

async function runLifecycle(
  run: number,
  baseline: number,
  checkpoints: MemoryCheckpoint[],
): Promise<LifecycleResult> {
  let snapshot: InkSnapshotV1 | null = createStandardPersistenceFixture();
  checkpoint(checkpoints, baseline, run, "main-fixture");
  let transientPeak = 0;
  const runtime = createRuntime(() => {
    transientPeak = Math.max(transientPeak, additionalBytes(baseline));
  });
  let exported = await fullExport(runtime, snapshot);
  checkpoint(checkpoints, baseline, run, "full-export");
  let adopted = await handoff(runtime, exported, checkpoints, baseline, run, "full");
  const fullOutputBytes = new TextEncoder().encode(adopted.output).byteLength;
  exported = null as never;
  checkpoint(checkpoints, baseline, run, "full-result-retained");
  materializeVaultWrite(adopted.output, checkpoints, baseline, run, "full");
  adopted = null as never;
  runtime.requestPrewarm();
  await waitForPrewarm(runtime, snapshot.elements.length);
  checkpoint(checkpoints, baseline, run, "full-output-released-prewarmed");

  const coalesced = coalesceCommits(snapshot);
  snapshot = coalesced.snapshot;
  checkpoint(checkpoints, baseline, run, "five-commit-coalesced-target");
  exported = await incrementalExport(runtime, coalesced.plan);
  checkpoint(checkpoints, baseline, run, "incremental-export");
  adopted = await handoff(runtime, exported, checkpoints, baseline, run, "incremental");
  const recovery = recoveryRetention(adopted, snapshot.revision - COALESCED_COMMITS);
  exported = null as never;
  checkpoint(checkpoints, baseline, run, "conflict-recovery-retention");
  materializeVaultWrite(adopted.output, checkpoints, baseline, run, "incremental");
  if (recovery.proof.revision !== adopted.modelRevision) {
    throw new Error("Invalid recovery proof.");
  }
  const outputBytes = new TextEncoder().encode(adopted.output).byteLength;
  adopted = null as never;
  snapshot = null;
  runtime.requestPrewarm();
  await waitForPrewarm(runtime, coalesced.snapshot.elements.length);
  checkpoint(checkpoints, baseline, run, "incremental-output-released-prewarmed");
  checkpoint(checkpoints, baseline, run, "save-cycle-retained");
  const activeInstrumentation = runtime.instrumentation;
  checkpoints.push({ bytes: transientPeak, phase: "worker-slice-transient-peak", run });
  runtime.terminate();
  return {
    cacheBytes: activeInstrumentation.cacheBytes,
    cacheElements: activeInstrumentation.cacheElements,
    outputBytes: Math.max(fullOutputBytes, outputBytes),
    released: runtime.instrumentation,
  };
}

async function waitForPrewarm(runtime: DocumentWorkerRuntime, elementCount: number): Promise<void> {
  while (runtime.instrumentation.prewarmedElements < elementCount) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function handoff(
  runtime: DocumentWorkerRuntime,
  exported: ExportSuccess,
  checkpoints: MemoryCheckpoint[],
  baseline: number,
  run: number,
  prefix: string,
): Promise<ExportSuccess & { readonly output: string }> {
  let encoded = await encodeRuntimeResultChunked(exported, sliceOptions());
  checkpoint(checkpoints, baseline, run, `${prefix}-wire-encoding`);
  let received = structuredClone(encoded.value, { transfer: [...encoded.transfer] });
  encoded = null as never;
  checkpoint(checkpoints, baseline, run, `${prefix}-wire-transfer`);
  const adopted = requireExport(await decodeRuntimeResultChunked(received, sliceOptions()));
  if (typeof adopted.output !== "string")
    throw new Error("Main thread did not adopt UTF-8 output.");
  checkpoint(checkpoints, baseline, run, `${prefix}-adoption-bytes-plus-string`);
  runtime.acknowledgeExport(exported, true);
  received = null as never;
  return adopted as ExportSuccess & { readonly output: string };
}

function coalesceCommits(snapshot: InkSnapshotV1) {
  const target = new CoalescedExportTarget<InkElementV1, PageV1>(snapshot.revision, ({ id }) => id);
  let changed = replaceFirstStroke(snapshot, snapshot.revision + 1);
  for (let commit = 1; commit <= COALESCED_COMMITS; commit += 1) {
    const revision = snapshot.revision + commit;
    changed = replaceFirstStroke(snapshot, revision);
    target.record({ changedElements: [changed], modelRevision: revision });
  }
  const plan = target.materialize({});
  if (plan.type !== "incremental" || plan.changedElements.length !== 1) {
    throw new Error("Five commits did not coalesce to one last-write-wins delta.");
  }
  return {
    plan,
    snapshot: {
      ...snapshot,
      elements: [changed, ...snapshot.elements.slice(1)],
      revision: plan.modelRevision,
    },
  };
}

function materializeVaultWrite(
  next: string,
  checkpoints: MemoryCheckpoint[],
  baseline: number,
  run: number,
  prefix: string,
): void {
  const currentVaultInput = new TextEncoder().encode(next);
  checkpoint(checkpoints, baseline, run, `${prefix}-vault-process-current-plus-next`);
  if (currentVaultInput.byteLength === 0) throw new Error("Incomplete vault input.");
}

function recoveryRetention(exported: ExportSuccess, baseRevision: number) {
  return Object.freeze({
    previousBase: Object.freeze({
      outputHash: "0".repeat(64),
      revision: baseRevision,
      type: "confirmed" as const,
    }),
    proof: Object.freeze({
      outputHash: exported.outputHash,
      revision: exported.modelRevision,
      saveOperationId: exported.exportGeneration,
    }),
  });
}

function createRuntime(observeSlice: () => void): DocumentWorkerRuntime {
  return createProductionDocumentRuntime(
    { sessionId: SESSION_ID, workerEpoch: WORKER_EPOCH },
    {
      workScheduler: createTestWorkScheduler({
        checkpoint: () => {
          observeSlice();
          return Promise.resolve();
        },
      }),
    },
  );
}

async function fullExport(runtime: DocumentWorkerRuntime, snapshot: InkSnapshotV1) {
  return requireExport(
    await runtime.execute({
      baseModelRevision: null,
      exportGeneration: 1,
      modelRevision: snapshot.revision,
      sessionId: SESSION_ID,
      snapshot,
      type: "export-full",
      workerEpoch: WORKER_EPOCH,
    }),
  );
}

async function incrementalExport(
  runtime: DocumentWorkerRuntime,
  plan: ReturnType<typeof coalesceCommits>["plan"],
) {
  return requireExport(
    await runtime.execute({
      ...plan,
      exportGeneration: 2,
      sessionId: SESSION_ID,
      type: "export-incremental",
      workerEpoch: WORKER_EPOCH,
    }),
  );
}

function requireExport(
  result: Awaited<ReturnType<DocumentWorkerRuntime["execute"]>>,
): ExportSuccess {
  if (result.type === "export-success") return result;
  throw new Error(result.type === "export-failure" ? result.error.code : result.type);
}

function sliceOptions() {
  return { checkpoint: () => Promise.resolve(), signal: new AbortController().signal };
}

function checkpoint(
  target: MemoryCheckpoint[],
  baseline: number,
  run: number,
  phase: string,
): void {
  globalThis.gc?.();
  target.push({ bytes: additionalBytes(baseline), phase, run });
}

function additionalBytes(baseline: number): number {
  return Math.max(0, liveHeapBytes() - baseline);
}

function liveHeapBytes(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

async function stabilizeGarbageCollection(): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    globalThis.gc?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function requireGarbageCollector(): void {
  if (globalThis.gc === undefined) {
    throw new Error("The memory lifecycle benchmark requires Node.js with --expose-gc.");
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
