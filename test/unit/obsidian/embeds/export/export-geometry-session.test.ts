// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import { ExportGeometrySession } from "../../../../../src/obsidian/embeds/export/export-geometry-session";
import * as documentRuntime from "../../../../../src/persistence/worker/runtime/public";
import * as geometry from "../../../../../src/persistence/export/export-geometry";
import { prepareExportCutsSteps } from "../../../../../src/domain/export/export-pagination";
import { FRAME_WORK_SHARE } from "../../../../../src/domain/scheduling/work-scheduler";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";

afterEach(() => vi.restoreAllMocks());

function nativeRuntime() {
  const runtime = new documentRuntime.DocumentWorkerRuntime({
    sessionId: "native-test",
    workerEpoch: 1,
  });
  return { runtime, terminate: vi.spyOn(runtime, "terminate") };
}

function preparedCuts() {
  const iterator = prepareExportCutsSteps([{ minY: 20, maxY: 40 }]);
  let step = iterator.next();
  while (!step.done) step = iterator.next();
  return step.value;
}

it("does not create a temporary executor or identity for an unused export", () => {
  const create = vi.spyOn(documentRuntime, "createDocumentRuntime");
  const uuid = vi.spyOn(crypto, "randomUUID");
  const session = new ExportGeometrySession(
    window,
    immediateWorkScheduler(),
    new AbortController().signal,
  );
  session.dispose();
  expect(create).not.toHaveBeenCalled();
  expect(uuid).not.toHaveBeenCalled();
});

it("reuses one executor for separate documents and terminates it once", async () => {
  const native = nativeRuntime();
  const create = vi
    .spyOn(documentRuntime, "createDocumentRuntime")
    .mockResolvedValue(native.runtime);
  const cuts = preparedCuts();
  const prepare = vi.spyOn(geometry, "prepareExportGeometry").mockResolvedValue(cuts);
  let budget = 1;
  const scheduler = { ...immediateWorkScheduler(), budgetMs: () => budget };
  const subscribe = vi.fn((_listener: () => void) => () => undefined);
  const uuid = vi.spyOn(crypto, "randomUUID");
  const session = new ExportGeometrySession(
    window,
    scheduler,
    new AbortController().signal,
    subscribe,
  );
  expect(await session.prepare("first.svg")).toBe(cuts);
  expect(await session.prepare("second.svg")).toBe(cuts);
  expect(create).toHaveBeenCalledOnce();
  expect(uuid).toHaveBeenCalledOnce();
  expect(create.mock.calls[0]?.[3]?.subscribeSchedulingProfile).toBe(subscribe);
  expect(
    prepare.mock.calls.map(([input, options]) => [
      input,
      options.runtime,
      options.identity.operationId,
    ]),
  ).toEqual([
    ["first.svg", native.runtime, 1],
    ["second.svg", native.runtime, 2],
  ]);
  expect(prepare.mock.calls[0]?.[1].identity.sessionId).toBe(
    prepare.mock.calls[1]?.[1].identity.sessionId,
  );
  const profile = create.mock.calls[0]?.[3]?.frameIntervalMilliseconds;
  expect(profile?.()).toBe(budget / FRAME_WORK_SHARE);
  budget = 2;
  expect(profile?.()).toBe(budget / FRAME_WORK_SHARE);
  session.dispose();
  session.dispose();
  expect(native.terminate).toHaveBeenCalledOnce();
});

it.each(["construction", "execution"] as const)(
  "uses one central fallback after native %s fails",
  async (failure) => {
    const native = failure === "execution" ? nativeRuntime() : undefined;
    const create = vi
      .spyOn(documentRuntime, "createDocumentRuntime")
      .mockImplementation(async () => {
        if (native === undefined) throw new Error("Worker construction failed.");
        return native.runtime;
      });
    const cuts = preparedCuts();
    const prepare = vi.spyOn(geometry, "prepareExportGeometry").mockResolvedValue(cuts);
    if (native !== undefined) prepare.mockRejectedValueOnce(new Error("Worker execution failed."));
    const session = new ExportGeometrySession(
      window,
      immediateWorkScheduler(),
      new AbortController().signal,
    );
    expect(await session.prepare("first.svg")).toBe(cuts);
    const fallback = prepare.mock.calls[native === undefined ? 0 : 1]?.[1].runtime;
    if (fallback === undefined) throw new Error("Missing fallback executor.");
    const terminate = vi.spyOn(fallback, "terminate");
    expect(fallback).toBeInstanceOf(documentRuntime.DocumentWorkerRuntime);
    expect(fallback).not.toBe(native?.runtime);
    expect(await session.prepare("second.svg")).toBe(cuts);
    expect(prepare.mock.calls[prepare.mock.calls.length - 1]?.[1].runtime).toBe(fallback);
    expect(create).toHaveBeenCalledOnce();
    if (native !== undefined) expect(native.terminate).toHaveBeenCalledOnce();
    session.dispose();
    expect(terminate).toHaveBeenCalledOnce();
  },
);

it("does not loop when the fallback executor also fails", async () => {
  const create = vi
    .spyOn(documentRuntime, "createDocumentRuntime")
    .mockRejectedValue(new Error("Worker unavailable."));
  const prepare = vi
    .spyOn(geometry, "prepareExportGeometry")
    .mockRejectedValue(new Error("Fallback failed."));
  const session = new ExportGeometrySession(
    window,
    immediateWorkScheduler(),
    new AbortController().signal,
  );
  expect(await session.prepare("first.svg")).toBeUndefined();
  expect(await session.prepare("second.svg")).toBeUndefined();
  expect(create).toHaveBeenCalledOnce();
  expect(prepare).toHaveBeenCalledTimes(2);
  session.dispose();
});

it("terminates a late executor after cancellation during asynchronous construction", async () => {
  const native = nativeRuntime();
  let finish!: (runtime: documentRuntime.DocumentRuntimePort) => void;
  vi.spyOn(documentRuntime, "createDocumentRuntime").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const prepare = vi.spyOn(geometry, "prepareExportGeometry");
  const controller = new AbortController();
  const session = new ExportGeometrySession(window, immediateWorkScheduler(), controller.signal);
  const pending = session.prepare("first.svg");
  controller.abort();
  finish(native.runtime);
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(native.terminate).toHaveBeenCalledOnce();
  expect(prepare).not.toHaveBeenCalled();
  session.dispose();
});
