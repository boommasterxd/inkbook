import { expect, it, vi } from "vitest";
import { SessionScenePaths } from "../../../../../src/obsidian/embeds/document-session/session-scene-paths";
import type { ScenePathPreparationObserver } from "../../../../../src/domain/geometry/prepared-scene-paths";
import type {
  DocumentRuntimePort,
  DocumentRuntimeRequest,
  DocumentRuntimeResult,
} from "../../../../../src/persistence/worker/runtime/public";

it.each([undefined, 2])(
  "preserves the admitted ID order and exact visible prefix across pre-start retargets, visibleCount=%s",
  async (visibleCount) => {
    const execute = vi.fn<DocumentRuntimePort["execute"]>(async (request, observer) => {
      if (request.type !== "prepare-scene-paths") throw new Error("Expected scene preparation.");
      const paths = [{ id: "visible-2", parts: [{ d: "M0 0Z", paint: "fill" as const }] }];
      const result = sceneResult(request);
      await observer?.scenePaths?.({ ...result, paths }, new AbortController().signal);
      return result;
    });
    const port: DocumentRuntimePort = { execute, terminate: vi.fn() };
    const session = createSession(port);
    const onProgress = vi.fn();
    const setRetarget = vi.fn<ScenePathPreparationObserver["setRetarget"]>((handler) => {
      handler?.(["overscan-2", "visible-2", "visible-1"]);
      handler?.(["overscan-2", "visible-2", "foreign"]);
    });
    expect(
      await session.prepare(
        ["visible-1", "visible-2", "overscan-1", "overscan-2"],
        new AbortController().signal,
        {
          ...(visibleCount === undefined ? {} : { visibleCount }),
          maxBytes: 1024,
          speculative: true,
          navigationReserve: true,
          onProgress,
          setRetarget,
        },
      ),
    ).toEqual([]);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0]).toMatchObject({
      ids: ["visible-2", "overscan-2"],
      maxBytes: 1024,
      streamProgress: true,
      speculative: true,
      navigationReserve: true,
    });
    const request = execute.mock.calls[0]![0];
    expect(request.type === "prepare-scene-paths" && request.visibleCount).toBe(
      visibleCount === undefined ? undefined : 1,
    );
    expect(onProgress).toHaveBeenCalledOnce();
    expect(setRetarget).toHaveBeenLastCalledWith(undefined);
  },
);

it("forwards a retarget requested during dispatch and releases cancellation and observer ownership", async () => {
  const controller = new AbortController();
  let retarget: ((ids: readonly string[]) => void) | undefined;
  const execute = vi.fn<DocumentRuntimePort["execute"]>(async (request) => {
    retarget?.(["visible-2"]);
    controller.abort();
    return sceneResult(request);
  });
  const retargetScenePreparation = vi.fn();
  const cancelScenePreparation = vi.fn();
  const port: DocumentRuntimePort = {
    execute,
    terminate: vi.fn(),
    retargetScenePreparation,
    cancelScenePreparation,
  };
  const setRetarget = vi.fn<ScenePathPreparationObserver["setRetarget"]>((handler) => {
    retarget = handler;
  });
  expect(
    await createSession(port).prepare(["visible-1", "visible-2", "overscan"], controller.signal, {
      visibleCount: 2,
      onProgress: vi.fn(),
      setRetarget,
    }),
  ).toBeUndefined();
  expect(retargetScenePreparation).toHaveBeenCalledWith(
    expect.objectContaining({ operationId: 1 }),
    ["visible-2"],
  );
  expect(cancelScenePreparation).toHaveBeenCalledOnce();
  expect(setRetarget).toHaveBeenLastCalledWith(undefined);
  expect(retarget).toBeUndefined();
});

it("owns IDs and validated priority and capacity before asynchronous synchronization", async () => {
  const execute = vi.fn<DocumentRuntimePort["execute"]>(async (request) => sceneResult(request));
  let resume!: () => void;
  const synchronize = () =>
    new Promise<boolean>((resolve) => {
      resume = () => resolve(true);
    });
  const ids = ["visible-1", "visible-2", "overscan"];
  const observer = { visibleCount: 2, maxBytes: 1024, onProgress: vi.fn(), setRetarget: vi.fn() };
  const pending = createSession({ execute, terminate: vi.fn() }, synchronize).prepare(
    ids,
    new AbortController().signal,
    observer,
  );
  expect(execute).not.toHaveBeenCalled();
  ids.splice(0, ids.length, "foreign");
  observer.visibleCount = -1;
  observer.maxBytes = 0;
  resume();
  expect(await pending).toEqual([]);
  expect(execute.mock.calls[0]![0]).toMatchObject({
    ids: ["visible-1", "visible-2", "overscan"],
    visibleCount: 2,
    maxBytes: 1024,
  });
  expect(observer.setRetarget).toHaveBeenLastCalledWith(undefined);
});

it("rejects an oversized ID snapshot before synchronization or dispatch", async () => {
  const execute = vi.fn<DocumentRuntimePort["execute"]>();
  const synchronize = vi.fn(async () => true);
  expect(
    await createSession({ execute, terminate: vi.fn() }, synchronize).prepare(
      Array.from({ length: 257 }, (_, index) => `stroke-${index}`),
      new AbortController().signal,
    ),
  ).toBeUndefined();
  expect(synchronize).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

it.each([
  { visibleCount: -1 },
  { visibleCount: 2 },
  { visibleCount: 0.5 },
  { maxBytes: 0 },
  { maxBytes: 4 * 1024 * 1024 + 1 },
  { maxBytes: NaN },
])("rejects invalid priority or capacity before synchronization: %j", async (options) => {
  const execute = vi.fn<DocumentRuntimePort["execute"]>();
  const synchronize = vi.fn(async () => true);
  const session = createSession({ execute, terminate: vi.fn() }, synchronize);
  expect(
    await session.prepare(["visible"], new AbortController().signal, {
      ...options,
      onProgress: vi.fn(),
      setRetarget: vi.fn(),
    }),
  ).toBeUndefined();
  expect(synchronize).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

function createSession(port: DocumentRuntimePort, synchronize = async () => true) {
  return new SessionScenePaths({
    disposed: () => false,
    executor: () => port,
    revision: () => 7,
    sessionId: "session-a",
    synchronize,
    workerEpoch: () => 1,
  });
}

function sceneResult(
  request: DocumentRuntimeRequest,
): Extract<DocumentRuntimeResult, { type: "prepare-scene-paths-success" }> {
  if (request.type !== "prepare-scene-paths") throw new Error("Expected scene preparation.");
  return {
    basisRevision: request.basisRevision,
    identity: request.identity,
    paths: [],
    type: "prepare-scene-paths-success",
  };
}
