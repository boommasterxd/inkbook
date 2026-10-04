import { expect, it } from "vitest";
import { ScenePathReceiver } from "../../../../../src/persistence/worker/runtime/scene-path-receiver";
import type { BridgeScenePaths } from "../../../../../src/persistence/worker/runtime/bridge-messages";

const identity = {
  sessionId: "session-a",
  workerEpoch: 1,
  operationId: 2,
  purpose: "background" as const,
};
const request = {
  streamProgress: true,
  basisRevision: 3,
  identity,
  ids: ["first", "second"],
  type: "prepare-scene-paths" as const,
};

function message(id = "first", index = 0, d = "M0 0Z"): BridgeScenePaths {
  return {
    batchIndex: index,
    requestId: 1,
    type: "inkbook-worker-scene-paths",
    batch: {
      basisRevision: 3,
      identity,
      paths: [{ id, parts: [{ d, paint: "fill" }] }],
      type: "prepare-scene-paths-success",
    },
  };
}

it.each(["revision", "identity", "index", "ids"])(
  "rejects stale or malformed progress for %s",
  async (invalid) => {
    const receiver = new ScenePathReceiver();
    const valid = message();
    const candidate = {
      revision: { ...valid, batch: { ...valid.batch, basisRevision: 2 } },
      identity: { ...valid, batch: { ...valid.batch, identity: { ...identity, operationId: 3 } } },
      index: { ...valid, batchIndex: 1 },
      ids: message("unknown"),
    }[invalid]!;
    await expect(
      receiver.adopt(candidate, request, undefined, new AbortController().signal, () => undefined),
    ).rejects.toThrow();
    expect(receiver.waiting).toBe(false);
  },
);

it("rejects repeated progress IDs across individually valid messages", async () => {
  const receiver = new ScenePathReceiver();
  const signal = new AbortController().signal;
  await receiver.adopt(message(), request, undefined, signal, () => undefined);
  await expect(
    receiver.adopt(message("first", 1), request, undefined, signal, () => undefined),
  ).rejects.toThrow("repeated an ID");
});

it("bounds cumulative contour bytes across individually bounded progress messages", async () => {
  const receiver = new ScenePathReceiver();
  const signal = new AbortController().signal;
  const d = "M0 0Z".repeat(250_000);
  await receiver.adopt(message("first", 0, d), request, undefined, signal, () => undefined);
  await expect(
    receiver.adopt(message("second", 1, d), request, undefined, signal, () => undefined),
  ).rejects.toThrow("byte limit");
});

it("rejects concurrent adoption and observes cancellation after acknowledgement work", async () => {
  const receiver = new ScenePathReceiver();
  const controller = new AbortController();
  let finish!: () => void;
  const admission = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const pending = receiver.adopt(message(), request, undefined, controller.signal, () => admission);
  expect(receiver.waiting).toBe(true);
  await expect(
    receiver.adopt(message(), request, undefined, controller.signal, () => undefined),
  ).rejects.toThrow("ordering");
  controller.abort();
  finish();
  await expect(pending).rejects.toThrow();
  expect(receiver.waiting).toBe(false);
});
