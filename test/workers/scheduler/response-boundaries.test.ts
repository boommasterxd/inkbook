import { describe, expect, it } from "vitest";

import { WORKER_PROTOCOL_VERSION } from "../../../src/workers/scheduler/protocol";
import { handleWorkerResponse } from "../../../src/workers/scheduler/response";
import type { PendingTask } from "../../../src/workers/scheduler/scheduler-types";
import { createPendingTask } from "../../../src/workers/scheduler/task";

const REVISION = { scene: 2, layout: 3 } as const;
const REQUEST_ID = 7;
const OUTPUT_BYTE = 4;
const SECOND_OUTPUT_BYTE = 5;
const TASK_BYTES = 2;
const SECOND_INPUT_BYTE = 2;

function createTask(): PendingTask {
  return createPendingTask(
    {
      workKind: "byte-process",
      input: new Uint8Array([1, SECOND_INPUT_BYTE]),
      revision: REVISION,
      priority: "current",
      mode: "active",
      maxOutputBytes: TASK_BYTES,
      scratchBytes: 0,
      workerFirst: true,
      requireSameSize: false,
    },
    REQUEST_ID,
  );
}

describe("worker response protocol boundaries", () => {
  it("ignores unrelated primitive and object messages", () => {
    const task = createTask();

    expect(handleWorkerResponse(null, task)).toEqual({ kind: "ignore" });
    expect(handleWorkerResponse({ requestId: 8 }, task)).toEqual({
      kind: "ignore",
    });
  });

  it("normalizes an error response without a message", () => {
    const outcome = handleWorkerResponse(
      {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        kind: "error",
        requestId: 7,
      },
      createTask(),
    );

    expect(outcome).toMatchObject({
      kind: "error",
      error: { message: "Worker request failed." },
    });
  });

  it("rejects a structured completion for a byte task", () => {
    const outcome = handleWorkerResponse(
      {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        kind: "structured-complete",
        requestId: 7,
        revision: REVISION,
        byteLength: 1,
        payload: { byte: 1 },
      },
      createTask(),
    );

    expect(outcome).toMatchObject({
      kind: "error",
      error: { message: "Worker result violates its work contract." },
    });
  });

  it("accepts a bounded complete response", () => {
    const payload = Uint8Array.from([OUTPUT_BYTE, SECOND_OUTPUT_BYTE]);
    const outcome = handleWorkerResponse(
      {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        kind: "complete",
        requestId: 7,
        revision: REVISION,
        byteLength: payload.byteLength,
        payload: payload.buffer,
      },
      createTask(),
    );

    expect(outcome).toEqual({ kind: "complete", output: payload });
  });

  it.each([1, { scene: 2, layout: 3.5 }])(
    "rejects the malformed revision %j",
    (revision) => {
      const payload = Uint8Array.from([OUTPUT_BYTE]);
      const outcome = handleWorkerResponse(
        {
          protocolVersion: WORKER_PROTOCOL_VERSION,
          kind: "complete",
          requestId: 7,
          revision,
          byteLength: payload.byteLength,
          payload: payload.buffer,
        },
        createTask(),
      );

      expect(outcome).toMatchObject({
        kind: "error",
        error: { message: "Worker response violates its protocol." },
      });
    },
  );
});
