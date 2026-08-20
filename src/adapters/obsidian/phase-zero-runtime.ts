import { MarkdownView, Notice, type Plugin } from "obsidian";

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
import {
  ObsidianWorkspaceBoundary,
  PhaseZeroViewRegistry,
  ViewAttachmentProbe,
} from "./views";

const PROBE_BYTE = 0x5a;
const EXPECTED_PROBE_BYTE = 0xa5;

export class PhaseZeroRuntime {
  readonly #plugin: Plugin;
  readonly #views = new PhaseZeroViewRegistry();
  readonly #attachments: ViewAttachmentProbe;
  readonly #history: PhaseZeroHistoryController;
  #recovery: Promise<RecoveryIndexedDbStore | undefined> | undefined;
  #disposed = false;
  #registered = false;

  public constructor(plugin: Plugin) {
    this.#plugin = plugin;
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
      vaultIdentityHint: plugin.app.vault.getName(),
      views: this.#views,
    });
  }

  public register(): void {
    if (this.#registered || this.#disposed) return;
    this.#registered = true;
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
          !this.#disposed &&
          view instanceof MarkdownView &&
          this.#history.canInsert(view);
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
        const path =
          !this.#disposed && view instanceof MarkdownView
            ? view.file?.path
            : undefined;
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
    const recovery = this.#recovery;
    if (recovery !== undefined) {
      void recovery.then((store) => store?.dispose());
    }
  }

  async #getRecoveryStore(): Promise<RecoveryIndexedDbStore | undefined> {
    if (this.#disposed) return undefined;
    this.#recovery ??= probeIndexedDbRecovery().then(async (result) => {
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
    if (this.#disposed) return;
    const environment = readWorkerEnvironment(globalThis);
    const slices = createSliceScheduler(globalThis);
    const scheduler = new PhaseZeroWorkerScheduler({
      clock: { now: (): number => globalThis.performance.now() },
      isCurrent: (revision): boolean =>
        revision.scene === 1 && revision.layout === 1,
      launchWorker: (): LaunchedBrowserWorker | undefined =>
        environment === undefined
          ? undefined
          : launchPhaseZeroWorker(environment),
      slices,
    });
    const workerPasses = await runWorkerProbe(scheduler);
    const recoveryPasses = (await this.#getRecoveryStore()) !== undefined;
    this.#notice(
      `Inkbook Phase 0 probe: worker ${passFail(workerPasses)}, recovery ${passFail(recoveryPasses)}.`,
    );
  }

  #notice(message: string): void {
    if (!this.#disposed) new Notice(message);
  }
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
): Promise<boolean> {
  try {
    const submission = scheduler.submit(
      new Uint8Array([PROBE_BYTE]),
      { layout: 1, scene: 1 },
      "current",
      "active",
    );
    const result = await submission.result;
    return result[0] === EXPECTED_PROBE_BYTE;
  } catch {
    return false;
  } finally {
    scheduler.dispose();
  }
}

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
