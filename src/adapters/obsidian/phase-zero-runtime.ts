import { MarkdownView, Notice, Platform, type Plugin } from "obsidian";

import {
  RESOURCE_BUDGET_V1,
  ResourceCoordinatorV1,
  type ResourceCategoryV1,
} from "../../application/resource-coordinator";

import {
  probeIndexedDbRecovery,
  type RecoveryIndexedDbStore,
} from "../recovery-indexed-db";
import {
  launchPhaseZeroWorker,
  PhaseZeroWorkerScheduler,
  type BrowserWorkerEnvironment,
  type LaunchedBrowserWorker,
  type PhaseZeroSliceScheduler,
} from "../../workers/phase-zero";
import { PhaseZeroHistoryController } from "./phase-zero-history-controller";
import type { WorkerProbeSettledMarkDetail } from "./startup-performance-marks";
import {
  ObsidianWorkspaceBoundary,
  PhaseZeroViewRegistry,
  ViewAttachmentProbe,
} from "./views";

const PROBE_BYTE = 0x5a;
const EXPECTED_PROBE_BYTE = 0xa5;
const WORKER_RESOURCE_CATEGORIES: readonly ResourceCategoryV1[] = Object.freeze(
  [
    "worker-cancellation",
    "worker-detached-buffer",
    "worker-input",
    "worker-message",
    "worker-output",
    "worker-owner",
    "worker-queued-job",
    "worker-resident",
    "worker-scratch",
    "worker-transfer",
  ],
);

export interface PhaseZeroRuntimePerformanceObserver {
  markWorkerProbeSettled(detail: WorkerProbeSettledMarkDetail): void;
}

type ResourceCoordinatorLifecycleSnapshot = Pick<
  ReturnType<ResourceCoordinatorV1["snapshot"]>,
  "balanced" | "disposed"
>;

const NOOP_PERFORMANCE_OBSERVER: PhaseZeroRuntimePerformanceObserver =
  Object.freeze({
    markWorkerProbeSettled: (): void => undefined,
  });

export class PhaseZeroRuntime {
  readonly #plugin: Plugin;
  readonly #resources: ResourceCoordinatorV1;
  readonly #views: PhaseZeroViewRegistry;
  readonly #attachments: ViewAttachmentProbe;
  readonly #history: PhaseZeroHistoryController;
  readonly #performanceObserver: PhaseZeroRuntimePerformanceObserver;
  readonly #workerSchedulers = new Set<PhaseZeroWorkerScheduler>();
  #recovery: Promise<RecoveryIndexedDbStore | undefined> | undefined;
  #disposal: Promise<void> | undefined;
  #disposed = false;
  #nextWorkerProbe = 1;

  public constructor(
    plugin: Plugin,
    resources: ResourceCoordinatorV1 = createResourceCoordinator(),
    performanceObserver: PhaseZeroRuntimePerformanceObserver = NOOP_PERFORMANCE_OBSERVER,
  ) {
    this.#plugin = plugin;
    this.#resources = resources;
    this.#performanceObserver = performanceObserver;
    this.#views = new PhaseZeroViewRegistry(this.#resources);
    this.#attachments = new ViewAttachmentProbe({
      failures: {
        report: (failure): void => {
          this.#notice(`Inkbook view probe blocked: ${failure}.`);
        },
      },
      resources: this.#views,
      workspace: new ObsidianWorkspaceBoundary(plugin.app.workspace),
    });
    this.#history = new PhaseZeroHistoryController({
      getRecoveryStore: (): Promise<RecoveryIndexedDbStore | undefined> =>
        this.#getRecoveryStore(),
      notice: (message): void => this.#notice(message),
      resourceCoordinator: this.#resources,
      vaultIdentityHint: plugin.app.vault.getName(),
      views: this.#views,
    });
  }

  public register(): void {
    this.#plugin.registerEditorExtension(this.#history.bridge.extension);
    this.#plugin.registerMarkdownPostProcessor((element, context): void => {
      if (!this.#disposed) this.#views.reportReadingSection(element, context);
    });
    this.#plugin.registerEvent(
      this.#plugin.app.workspace.on("layout-change", () =>
        this.#attachments.reconcile(),
      ),
    );
    this.#plugin.registerEvent(
      this.#plugin.app.workspace.on("active-leaf-change", () =>
        this.#attachments.reconcile(),
      ),
    );
    this.#plugin.addCommand({
      id: "phase-zero-insert-annotation",
      name: "Phase 0: Insert annotation history probe",
      editorCheckCallback: (checking, editor, view): boolean => {
        const available =
          view instanceof MarkdownView && this.#history.canInsert(view);
        if (!checking && available) {
          void this.#history.insertProbeAnnotation(editor, view);
        }
        return available;
      },
    });
    this.#plugin.addCommand({
      id: "phase-zero-show-transient-input-probe",
      name: "Phase 0: Show transient input probe",
      editorCheckCallback: (checking, _editor, view): boolean => {
        const path = view instanceof MarkdownView ? view.file?.path : undefined;
        if (!checking && path !== undefined) {
          this.#views.render(path, "transient-input-probe");
        }
        return path !== undefined;
      },
    });
    this.#plugin.addCommand({
      callback: (): Promise<void> => this.#runEnvironmentProbe(),
      id: "phase-zero-run-environment-probe",
      name: "Phase 0: Run worker and recovery probe",
    });
    this.#plugin.addCommand({
      callback: () => this.#notice(this.#history.status()),
      id: "phase-zero-show-status",
      name: "Phase 0: Show probe status",
    });
    this.#attachments.start();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#attachments.dispose();
    this.#history.dispose();
    this.#views.dispose();
    for (const scheduler of this.#workerSchedulers) scheduler.dispose();
    this.#workerSchedulers.clear();
    const recovery = this.#recovery;
    this.#disposal = this.#finishDisposal(recovery);
  }

  public settle(): Promise<void> {
    return this.#disposal ?? Promise.resolve();
  }

  public resourceSnapshot(): ResourceCoordinatorLifecycleSnapshot {
    const snapshot = this.#resources.snapshot();
    return Object.freeze({
      balanced: snapshot.balanced,
      disposed: snapshot.disposed,
    });
  }

  async #getRecoveryStore(): Promise<RecoveryIndexedDbStore | undefined> {
    if (this.#disposed) return undefined;
    this.#recovery ??= probeIndexedDbRecovery({
      resourceCoordinator: this.#resources,
    }).then(async (result) => {
      if (result.kind !== "ready") {
        this.#notice(`Inkbook recovery is read-only: ${result.reason}.`);
        return undefined;
      }
      if (this.#disposed) {
        await result.store.dispose();
        return undefined;
      }
      return result.store;
    });
    return this.#recovery;
  }

  async #runEnvironmentProbe(): Promise<void> {
    const environment = readWorkerEnvironment(globalThis);
    const slices = createSliceScheduler(globalThis);
    const ownerId = `phase-zero-environment-worker:${String(this.#nextWorkerProbe)}`;
    this.#nextWorkerProbe += 1;
    const scheduler = new PhaseZeroWorkerScheduler({
      clock: { now: (): number => globalThis.performance.now() },
      isCurrent: (revision): boolean =>
        revision.scene === 1 && revision.layout === 1,
      launchWorker: (): LaunchedBrowserWorker | undefined =>
        environment === undefined
          ? undefined
          : launchPhaseZeroWorker(environment),
      resourceCoordinator: this.#resources,
      resourceOwnerId: ownerId,
      slices,
    });
    this.#workerSchedulers.add(scheduler);
    let workerProbe = createFailedWorkerProbeResult();
    try {
      workerProbe = await runWorkerProbe(scheduler, this.#resources);
      workerProbe = Object.freeze({
        ...workerProbe,
        recoveryPassed: (await this.#getRecoveryStore()) !== undefined,
      });
      this.#notice(
        `Inkbook Phase 0 probe: worker ${passFail(workerProbe.workerResultPassed)}, recovery ${passFail(workerProbe.recoveryPassed)}.`,
      );
    } finally {
      try {
        this.#performanceObserver.markWorkerProbeSettled(workerProbe);
      } catch {
        // Performance evidence must never change probe behavior.
      }
      this.#workerSchedulers.delete(scheduler);
    }
  }

  async #finishDisposal(
    recovery: Promise<RecoveryIndexedDbStore | undefined> | undefined,
  ): Promise<void> {
    try {
      await this.#history.settle();
      const store = await recovery;
      await store?.dispose();
    } finally {
      this.#resources.dispose();
    }
  }

  #notice(message: string): void {
    if (!this.#disposed) new Notice(message);
  }
}

function createResourceCoordinator(): ResourceCoordinatorV1 {
  return new ResourceCoordinatorV1(
    Platform.isPhone
      ? RESOURCE_BUDGET_V1.androidPhone
      : RESOURCE_BUDGET_V1.desktopOrAndroidTablet,
  );
}

function readWorkerEnvironment(
  root: typeof globalThis,
): BrowserWorkerEnvironment | undefined {
  if (
    typeof root.Blob !== "function" ||
    typeof root.Worker !== "function" ||
    typeof root.URL.createObjectURL !== "function" ||
    typeof root.URL.revokeObjectURL !== "function"
  ) {
    return undefined;
  }
  return { Blob: root.Blob, URL: root.URL, Worker: root.Worker };
}

async function runWorkerProbe(
  scheduler: PhaseZeroWorkerScheduler,
  resources: ResourceCoordinatorV1,
): Promise<WorkerProbeSettledMarkDetail> {
  let result: Awaited<PhaseZeroSubmissionResult> | undefined;
  let workerLaunched = false;
  let workerResultPassed = false;
  try {
    const submission = scheduler.submitStaged(
      1,
      (input): void => {
        input[0] = PROBE_BYTE;
      },
      { layout: 1, scene: 1 },
      "current",
      "active",
    );
    workerLaunched = hasLiveWorkerOwner(resources.snapshot());
    result = await submission.result;
    workerResultPassed = result[0] === EXPECTED_PROBE_BYTE;
  } catch {
    // The initialized false state records a failed worker result.
  } finally {
    result?.release();
    scheduler.dispose();
  }
  return Object.freeze({
    workerLaunched,
    workerResultPassed,
    recoveryPassed: false,
    workerResourcesReleased: workerResourcesReleased(resources.snapshot()),
  });
}

function createFailedWorkerProbeResult(): WorkerProbeSettledMarkDetail {
  return Object.freeze({
    workerLaunched: false,
    workerResultPassed: false,
    recoveryPassed: false,
    workerResourcesReleased: false,
  });
}

function hasLiveWorkerOwner(
  snapshot: ReturnType<ResourceCoordinatorV1["snapshot"]>,
): boolean {
  return hasLiveResource(snapshot, "worker-owner");
}

function workerResourcesReleased(
  snapshot: ReturnType<ResourceCoordinatorV1["snapshot"]>,
): boolean {
  return WORKER_RESOURCE_CATEGORIES.every(
    (category) => !hasLiveResource(snapshot, category),
  );
}

function hasLiveResource(
  snapshot: ReturnType<ResourceCoordinatorV1["snapshot"]>,
  category: ResourceCategoryV1,
): boolean {
  const entry = snapshot.categories[category];
  if (entry === undefined) return false;
  return (
    entry.current.count !== 0 ||
    entry.current.bytes !== 0 ||
    entry.reserved.count !== 0 ||
    entry.reserved.bytes !== 0
  );
}

type PhaseZeroSubmissionResult = ReturnType<
  PhaseZeroWorkerScheduler["submit"]
>["result"];

function createSliceScheduler(
  root: typeof globalThis,
): PhaseZeroSliceScheduler {
  return {
    schedule: (_mode, callback): (() => void) => {
      const handle = root.setTimeout(callback, 0);
      return (): void => root.clearTimeout(handle);
    },
  };
}

function passFail(value: boolean): "pass" | "fail" {
  return value ? "pass" : "fail";
}
