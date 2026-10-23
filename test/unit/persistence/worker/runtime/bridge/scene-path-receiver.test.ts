import { expect, it } from "vitest";
import { ScenePathReceiver } from "../../../../../../src/persistence/worker/runtime/bridge/scene-path-receiver";
import type { BridgeScenePaths } from "../../../../../../src/persistence/worker/runtime/bridge/bridge-messages";
import { MAX_SCENE_PATH_BYTES } from "../../../../../../src/persistence/worker/runtime/model/scene-path-limits";

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

it.each(["runtime-failure", "unknown"])(
  "rejects progress with the unexpected result type %s",
  async (type) => {
    const receiver = new ScenePathReceiver(request);
    const invalid = {
      ...message(),
      batch: { ...message().batch, type },
    } as unknown as BridgeScenePaths;
    await expect(
      receiver.adopt(invalid, request, undefined, new AbortController().signal, () => undefined),
    ).rejects.toThrow("requires contours");
    expect(receiver.waiting).toBe(false);
  },
);

it("bounds cumulative contour bytes across individually bounded progress messages", async () => {
  const receiver = new ScenePathReceiver();
  const signal = new AbortController().signal;
  const d = "M0 0Z".repeat(250_000);
  await receiver.adopt(message("first", 0, d), request, undefined, signal, () => undefined);
  await expect(
    receiver.adopt(message("second", 1, d), request, undefined, signal, () => undefined),
  ).rejects.toThrow("byte limit");
});

it("enforces an owned remaining-capacity limit cumulatively across progress and terminal contours", async () => {
  const boundedRequest = { ...request, maxBytes: 280 };
  const receiver = new ScenePathReceiver(boundedRequest);
  const signal = new AbortController().signal;
  const observer = { unlockBatch: () => undefined, scenePaths: () => undefined };
  boundedRequest.maxBytes = MAX_SCENE_PATH_BYTES;
  await receiver.adopt(message(), boundedRequest, observer, signal, () => undefined);
  await expect(
    receiver.validateResult(boundedRequest, message("second", 1).batch, {
      signal,
      checkpoint: () => undefined,
    }),
  ).rejects.toThrow("byte limit");
  expect(receiver.waiting).toBe(false);
  await expect(
    new ScenePathReceiver({ ...request, maxBytes: 1 }).adopt(
      message(),
      request,
      observer,
      signal,
      () => undefined,
    ),
  ).rejects.toThrow("transport contract");
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

it("owns a validated ID and scalar snapshot before the first response or retarget", async () => {
  const mutable = { ...request, identity: { ...identity }, ids: [...request.ids] };
  const receiver = new ScenePathReceiver(mutable);
  mutable.ids[0] = "unknown";
  mutable.identity.operationId++;
  mutable.basisRevision++;
  const retained = ["first"];
  receiver.retarget(retained);
  retained[0] = "unknown";
  const owned = receiver.request!;
  expect(Object.isFrozen(owned)).toBe(true);
  expect(receiver.retainedIds).toEqual(["first"]);
  const signal = new AbortController().signal;
  await receiver.adopt(message(), owned, undefined, signal, () => undefined);
  await expect(
    receiver.adopt(message("unknown", 1), owned, undefined, signal, () => undefined),
  ).rejects.toThrow("visible IDs");
});

it("includes terminal contours in cumulative order and bytes without recharging empty completion", async () => {
  const signal = new AbortController().signal;
  const options = { checkpoint: () => undefined, signal };
  const receiver = new ScenePathReceiver(request);
  await receiver.adopt(message(), request, undefined, signal, options.checkpoint);
  await expect(receiver.validateResult(request, message().batch, options)).rejects.toThrow(
    "repeated an ID",
  );
  const bounded = new ScenePathReceiver(request);
  const d = "M0 0Z".repeat(250_000);
  await bounded.adopt(message("first", 0, d), request, undefined, signal, options.checkpoint);
  await expect(
    bounded.validateResult(request, { ...message().batch, paths: [] }, options),
  ).resolves.toBeUndefined();
  await expect(
    bounded.validateResult(request, message("second", 1, d).batch, options),
  ).rejects.toThrow("byte limit");
});

it.each(
  [["first", "first"], [""], ["x".repeat(129)], Array.from({ length: 257 }, () => "first")].map(
    (ids) => [ids],
  ),
)("rejects malformed or oversized request snapshots: %j", (ids) => {
  expect(() => new ScenePathReceiver({ ...request, ids })).toThrow(TypeError);
});

it.each(["first", null, [undefined]].map((ids) => [ids]))(
  "rejects non-array or invalid ID snapshots: %j",
  (ids) => {
    expect(
      () => new ScenePathReceiver({ ...request, ids: ids as unknown as readonly string[] }),
    ).toThrow(TypeError);
  },
);

it("accepts the exact byte ceiling and empty request completion, then rejects additional bytes", async () => {
  const signal = new AbortController().signal;
  const options = { checkpoint: () => undefined, signal };
  const empty = { ...request, ids: [] };
  const blank = { ...message().batch, paths: [] };
  await new ScenePathReceiver(empty).validateResult(empty, blank, options);
  const receiver = new ScenePathReceiver(request);
  const d = "0".repeat((MAX_SCENE_PATH_BYTES - 128 - "first".length * 2) / 2);
  await receiver.adopt(message("first", 0, d), request, undefined, signal, options.checkpoint);
  await receiver.validateResult(request, blank, options);
  await expect(
    receiver.validateResult(request, message("second", 1).batch, options),
  ).rejects.toThrow("byte limit");
});
