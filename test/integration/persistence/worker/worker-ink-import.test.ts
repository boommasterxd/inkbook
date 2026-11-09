import { describe, expect, it } from "vitest";
import { validImportInkDetails } from "../../../../src/persistence/worker/runtime/wire/ink-import-wire";
import {
  DocumentWorkerRuntime,
  GestureAwareSliceScheduler,
} from "../../../../src/persistence/worker/runtime/public";
import {
  createWorkerBridgeClient,
  createWorkerBridgeHarness,
} from "../../../fixtures/persistence/worker-bridge";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import {
  decodeRuntimeRequestChunked,
  encodeRuntimeRequest,
  isDocumentRuntimeWireResult,
} from "../../../../src/persistence/worker/runtime/wire/wire-codec";

const IDENTITY = {
  sessionId: "session-a",
  workerEpoch: 1,
  operationId: 1,
  purpose: "migration" as const,
};
const INPUT =
  '<svg xmlns="http://www.w3.org/2000/svg"><metadata><ink file-type="inkWriting"/><ink-canvas version="0.5.0">{"version":1,"strokes":[],"gridEnabled":false,"writingLineHeight":101}</ink-canvas></metadata></svg>';
const REQUEST = {
  identity: IDENTITY,
  input: INPUT,
  legacyWriting: false,
  timestamp: 1000,
  type: "import-ink" as const,
};

describe("worker Ink import", () => {
  it("transfers canonical native output and verifies it through the owned runtime", async () => {
    const { clientEndpoint, hostEndpoint, detach, runtime } = createWorkerBridgeHarness();
    clientEndpoint.cloneTransfers = true;
    hostEndpoint.cloneTransfers = true;
    const client = createWorkerBridgeClient(clientEndpoint);
    try {
      const result = await client.execute(REQUEST);
      expect(result.type).toBe("import-ink-success");
      if (result.type !== "import-ink-success") throw new Error("Expected converted output.");
      expect(result.exported.output).toContain('data-inkbook-version="1"');
      expect(result.exported.modelRevision).toBe(0);
      expect(result.warningCodes).toEqual(["backgroundSpacingPreset"]);
      expect(result.warnings).toEqual([
        "Background spacing was mapped to the nearest Inkbook preset.",
      ]);
      expect(
        await client.execute({
          identity: { ...IDENTITY, operationId: 2, purpose: "verification" },
          input: result.exported.output,
          type: "verify-output",
          versionPolicy: "current",
        }),
      ).toMatchObject({
        type: "verify-output-success",
        persisted: { type: "confirmed", outputHash: result.exported.outputHash, revision: 0 },
      });
      expect(hostEndpoint.transfers.some((transfer) => transfer.length === 1)).toBe(true);
      expect(runtime.instrumentation.unacknowledgedExports).toBe(0);
    } finally {
      client.terminate();
      detach();
    }
    expect(clientEndpoint.terminated).toBe(true);
    expect(runtime.instrumentation.retainedJobs).toBe(0);
  });

  it("uses the same canonical algorithm in the centrally scheduled fallback", async () => {
    let checkpoints = 0;
    const runtime = new DocumentWorkerRuntime(
      IDENTITY,
      new GestureAwareSliceScheduler({
        isInputActive: () => false,
        workScheduler: createTestWorkScheduler({
          checkpoint: () => {
            checkpoints += 1;
          },
        }),
      }),
    );
    try {
      const result = await runtime.execute(REQUEST);
      expect(result.type).toBe("import-ink-success");
      expect(result).toMatchObject({ warningCodes: ["backgroundSpacingPreset"] });
      expect(checkpoints).toBeGreaterThan(0);
      expect(await runtime.execute({ ...REQUEST, input: "not an Ink document" })).toMatchObject({
        type: "runtime-failure",
        retryable: false,
        code: "import-invalid-source",
      });
    } finally {
      runtime.terminate();
    }
  });

  it("cancels conversion at shared admission and releases queued jobs", async () => {
    let runtime: DocumentWorkerRuntime;
    runtime = new DocumentWorkerRuntime(
      IDENTITY,
      new GestureAwareSliceScheduler({
        isInputActive: () => false,
        workScheduler: createTestWorkScheduler({
          checkpoint: () => {
            runtime.terminate();
            return Promise.resolve();
          },
        }),
      }),
    );
    await expect(runtime.execute(REQUEST)).rejects.toThrow("terminated");
    expect(runtime.instrumentation).toMatchObject({ retainedJobs: 0, queuedJobs: 0 });
  });
});

describe("worker Ink import wire validation", () => {
  it("rejects oversized or malformed import requests before dispatch or decoding", async () => {
    expect(() =>
      encodeRuntimeRequest({ ...REQUEST, input: "x".repeat(16 * 1024 * 1024 + 1) }),
    ).toThrow("oversized");
    await expect(
      decodeRuntimeRequestChunked(
        { ...REQUEST, timestamp: NaN },
        {
          checkpoint: () => undefined,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow("Invalid");
    const details = { exported: { type: "export-success-wire" }, warnings: [] };
    expect(validImportInkDetails({ ...details, warningCodes: ["backgroundSpacingPreset"] })).toBe(
      true,
    );
    expect(validImportInkDetails({ ...details, warningCodes: ["unknown"] })).toBe(false);
    expect(
      validImportInkDetails({ ...details, warningCodes: Array(101).fill("nativeBrush") }),
    ).toBe(false);
    expect(
      isDocumentRuntimeWireResult({ type: "import-ink-success-wire", warnings: [], exported: {} }),
    ).toBe(false);
  });
});
