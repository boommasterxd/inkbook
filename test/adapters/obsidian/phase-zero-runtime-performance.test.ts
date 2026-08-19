// @vitest-environment happy-dom

import { IDBFactory } from "fake-indexeddb";
import type { Plugin } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RESOURCE_BUDGET_V1,
  ResourceCoordinatorV1,
} from "../../../src/application/resource-coordinator";
import {
  PhaseZeroRuntime,
  type PhaseZeroRuntimePerformanceObserver,
} from "../../../src/adapters/obsidian/phase-zero-runtime";
import type { WorkerProbeSettledMarkDetail } from "../../../src/adapters/obsidian/startup-performance-marks";
import {
  PHASE_ZERO_PROTOCOL_VERSION,
  type PhaseZeroWorkerRequest,
} from "../../../src/workers/phase-zero";

const TRANSFORM_MASK = 0xff;

class ProbeWorker extends EventTarget {
  public readonly terminate = vi.fn<() => void>();

  public postMessage(message: PhaseZeroWorkerRequest): void {
    if (message.kind !== "transform") return;
    const input = new Uint8Array(message.payload);
    const output = Uint8Array.from(input, (value) => value ^ TRANSFORM_MASK);
    queueMicrotask(() => {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: {
            protocolVersion: PHASE_ZERO_PROTOCOL_VERSION,
            kind: "complete",
            requestId: message.requestId,
            revision: message.revision,
            byteLength: output.byteLength,
            payload: output.buffer,
          },
        }),
      );
    });
  }
}

interface TestCommand {
  readonly callback?: () => unknown;
  readonly id: string;
}

type TestPlugin = Plugin & {
  readonly commands: TestCommand[];
};

function createPlugin(): TestPlugin {
  const commands: TestCommand[] = [];
  return {
    app: {
      vault: { getName: (): string => "runtime-performance-vault" },
      workspace: {
        iterateAllLeaves: vi.fn(),
        on: vi.fn(() => ({})),
        onLayoutReady: vi.fn(),
      },
    },
    commands,
    registerEditorExtension: vi.fn(),
    registerEvent: vi.fn(),
    registerMarkdownPostProcessor: vi.fn(),
    addCommand: vi.fn((command: TestCommand): void => {
      commands.push(command);
    }),
  } as unknown as TestPlugin;
}

function installIndexedDb(): () => void {
  const previous = globalThis.indexedDB;
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: new IDBFactory(),
  });
  return (): void => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: previous,
    });
  };
}

function installWorkerEnvironment(workerAvailable: boolean): () => void {
  const WorkerConstructor = workerAvailable ? ProbeWorker : undefined;
  vi.stubGlobal("Worker", WorkerConstructor);
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:inkbook-runtime-probe"),
    revokeObjectURL: vi.fn(),
  });
  return (): void => {
    vi.unstubAllGlobals();
  };
}

function probeCommand(plugin: TestPlugin): { callback: () => Promise<void> } {
  const command = plugin.commands.find(
    (candidate) => candidate.id === "phase-zero-run-environment-probe",
  );
  if (command?.callback === undefined) {
    throw new Error("Environment probe command was not registered.");
  }
  return {
    callback: async (): Promise<void> => {
      await command.callback?.();
    },
  };
}

async function runProbe(workerAvailable: boolean): Promise<{
  readonly detail: {
    readonly workerLaunched: boolean;
    readonly workerResultPassed: boolean;
    readonly recoveryPassed: boolean;
    readonly workerResourcesReleased: boolean;
  };
  readonly runtime: PhaseZeroRuntime;
}> {
  const restoreWorker = installWorkerEnvironment(workerAvailable);
  const restoreIndexedDb = installIndexedDb();
  const markWorkerProbeSettled =
    vi.fn<(detail: WorkerProbeSettledMarkDetail) => void>();
  const observer: PhaseZeroRuntimePerformanceObserver = {
    markWorkerProbeSettled,
  };
  const resources = new ResourceCoordinatorV1(
    RESOURCE_BUDGET_V1.desktopOrAndroidTablet,
  );
  const plugin = createPlugin();
  const runtime = new PhaseZeroRuntime(plugin, resources, observer);
  runtime.register();
  const command = probeCommand(plugin);
  await command.callback();
  const detail = markWorkerProbeSettled.mock.calls[0]?.[0];
  if (detail === undefined)
    throw new Error("Worker probe mark was not emitted.");
  restoreWorker();
  restoreIndexedDb();
  return { detail, runtime };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PhaseZeroRuntime performance evidence", () => {
  it("reports actual worker launch, successful result, recovery, and released worker resources", async () => {
    const { detail, runtime } = await runProbe(true);

    expect(detail).toEqual({
      workerLaunched: true,
      workerResultPassed: true,
      recoveryPassed: true,
      workerResourcesReleased: true,
    });

    runtime.dispose();
    await runtime.settle();
  });

  it("reports fallback execution without claiming a worker launch", async () => {
    const { detail, runtime } = await runProbe(false);

    expect(detail).toEqual({
      workerLaunched: false,
      workerResultPassed: true,
      recoveryPassed: true,
      workerResourcesReleased: true,
    });

    runtime.dispose();
    await runtime.settle();
  });

  it("exposes balanced and disposed resource state after terminal settlement", async () => {
    const resources = new ResourceCoordinatorV1(
      RESOURCE_BUDGET_V1.desktopOrAndroidTablet,
    );
    const runtime = new PhaseZeroRuntime(createPlugin(), resources);

    runtime.register();
    runtime.dispose();
    await runtime.settle();

    expect(runtime.resourceSnapshot()).toEqual({
      balanced: true,
      disposed: true,
    });
  });
});
