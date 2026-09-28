import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/persistence/worker/runtime/worker-source", () => ({
  DOCUMENT_WORKER_GZIP:
    "<Ah!!!!!9-SOx5;6=n}85SXsqn,*>3h^H>}Exb9V{|jvA7Y:d=.UqU,ZbU-W<0z#{mr4#O5Q(g)*!!!!",
}));

import { createBuiltInSettings } from "../../../../src/domain/settings";
import { FRAME_WORK_SHARE } from "../../../../src/domain/scheduling/work-scheduler";
import {
  validateDocumentOutput,
  type DocumentOutputScheduling,
} from "../../../../src/obsidian/commands/document-output-validation";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { immediateWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";
import { TestWorkerEndpoint } from "../../../fixtures/persistence/worker-endpoint";

function fallbackApp(
  ownerWindow: Window = {
    crypto: { getRandomValues: (bytes: Uint8Array) => bytes.fill(7) },
  } as unknown as Window,
): App {
  return {
    workspace: {
      getActiveViewOfType: () => ({
        containerEl: { ownerDocument: { defaultView: ownerWindow } },
      }),
    },
  } as unknown as App;
}

class ControlledWorker extends TestWorkerEndpoint {
  static current: ControlledWorker | undefined;
  readonly response = new TestWorkerEndpoint();

  public constructor() {
    super();
    this.peer = this.response;
    this.response.peer = this;
    ControlledWorker.current = this;
  }

  public failVerification(): void {
    this.response.postMessage({
      code: "executor-failed",
      requestId: 1,
      type: "inkbook-worker-error",
    });
  }
}

function validDocument(): string {
  const settings = createBuiltInSettings();
  const serialized = serializeInkbookDocument({
    elements: [],
    format: "inkbook",
    page: {
      activeBufferLines: settings.pageDefaults.activeBufferLines,
      background: { type: "none" },
      innerWidth: 2000,
      lockedBufferLines: settings.pageDefaults.lockedBufferLines,
      margin: 24.3,
    },
    revision: 0,
    version: 1,
  });
  if (!serialized.ok) throw new Error(serialized.error.message);
  return serialized.value.svg;
}

function scheduling(): DocumentOutputScheduling {
  return {
    workScheduler: () => immediateWorkScheduler(),
    subscribeSchedulingProfile: () => () => undefined,
  };
}

describe("created document validation", () => {
  it("validates complete read-back output through the bounded fallback", async () => {
    await expect(
      validateDocumentOutput(fallbackApp(), validDocument(), scheduling()),
    ).resolves.toBe(true);
  });

  it("rejects corrupted read-back output through the bounded fallback", async () => {
    await expect(validateDocumentOutput(fallbackApp(), "<svg />", scheduling())).resolves.toBe(
      false,
    );
  });

  it("forwards live profile changes and releases the subscription after worker failure", async () => {
    const listeners = new Set<() => void>();
    const revoked: string[] = [];
    let budget = 4;
    const ownerWindow = {
      Blob,
      DecompressionStream,
      Response,
      Worker: ControlledWorker,
      URL: {
        createObjectURL: () => "blob:validation-worker",
        revokeObjectURL: (url: string) => revoked.push(url),
      },
      crypto: { getRandomValues: (bytes: Uint8Array) => bytes.fill(7) },
    } as unknown as Window;
    const validation = validateDocumentOutput(fallbackApp(ownerWindow), validDocument(), {
      workScheduler: () => ({ ...immediateWorkScheduler(), budgetMs: () => budget }),
      subscribeSchedulingProfile: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });

    await vi.waitFor(() =>
      expect(ControlledWorker.current?.sentMessages).toContainEqual(
        expect.objectContaining({ type: "inkbook-worker-request" }),
      ),
    );
    expect(listeners.size).toBe(1);
    budget = 2;
    for (const listener of listeners) listener();
    expect(ControlledWorker.current?.sentMessages).toContainEqual({
      action: "set-profile",
      frameIntervalMilliseconds: 2 / FRAME_WORK_SHARE,
      sliceMilliseconds: 2,
      type: "inkbook-worker-control",
    });

    ControlledWorker.current?.failVerification();
    await expect(validation).resolves.toBe(true);
    expect(listeners.size).toBe(0);
    expect(ControlledWorker.current?.terminated).toBe(true);
    expect(revoked).toEqual(["blob:validation-worker"]);
  });
});
