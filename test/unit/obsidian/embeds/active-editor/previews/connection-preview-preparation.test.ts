import { expect, it, vi } from "vitest";
import { ConnectedSelectionPreviewSession } from "../../../../../../src/editor/selection/public";
import { connectionChain } from "../../../../../fixtures/domain/connection-chain";
import { ElementStore } from "../../../../../../src/domain/store/public";
import { ConnectionPreviewPreparation } from "../../../../../../src/obsidian/embeds/active-editor/previews/connection-preview-preparation";
import { ElementSceneStore } from "../../../../../../src/obsidian/embeds/active-editor/scene-store";
import { immediateWorkScheduler } from "../../../../../fixtures/obsidian/immediate-work-scheduler";
import { connectedLine, rectangle } from "../../../../domain/store/fixtures";

function fixture() {
  const shape = rectangle();
  const line = connectedLine(shape);
  const store = new ElementStore([shape, line]);
  const sceneStore = new ElementSceneStore(store);
  const prepare = vi.spyOn(sceneStore, "prepareConnections");
  const scheduler = immediateWorkScheduler();
  const ready = vi.fn();
  return { shape, line, store, sceneStore, prepare, scheduler, ready };
}

it("reuses preparation until the graph changes and refreshes only completed work", async () => {
  const test = fixture();
  const preparation = new ConnectionPreviewPreparation(test, test.line, test.ready);
  try {
    preparation.ensure();
    expect(test.prepare).toHaveBeenCalledOnce();
    await test.prepare.mock.results[0]!.value;
    expect(test.ready).toHaveBeenCalledOnce();
    test.store.replace(test.line.id, {
      ...test.line,
      style: { ...test.line.style, outlineOpacity: 0.5 },
    });
    preparation.ensure();
    expect(test.prepare).toHaveBeenCalledOnce();
    test.store.replace(test.line.id, { ...test.line, startConnection: null });
    preparation.ensure();
    expect(test.prepare).toHaveBeenCalledTimes(2);
    await test.prepare.mock.results[1]!.value;
    expect(test.ready).toHaveBeenCalledTimes(2);
  } finally {
    preparation.dispose();
    test.sceneStore.release();
  }
});

it("cancels pending work and detaches the graph subscription on disposal", async () => {
  const test = fixture();
  let complete!: (ready: boolean) => void;
  test.prepare.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        complete = resolve;
      }),
  );
  const preparation = new ConnectionPreviewPreparation(test, test.line, test.ready);
  const signal = test.prepare.mock.calls[0]![2]!;
  preparation.dispose();
  expect(signal.aborted).toBe(true);
  complete(true);
  await test.prepare.mock.results[0]!.value;
  expect(test.ready).not.toHaveBeenCalled();
  test.store.remove([test.line.id]);
  preparation.ensure();
  expect(test.prepare).toHaveBeenCalledOnce();
  test.sceneStore.release();
});

it("keeps failed preparation closed without unhandled rejection", async () => {
  const test = fixture();
  test.prepare.mockRejectedValue(new Error("Preparation failed."));
  const preparation = new ConnectionPreviewPreparation(test, test.line, test.ready);
  await expect(test.prepare.mock.results[0]!.value).rejects.toThrow("Preparation failed.");
  expect(test.ready).not.toHaveBeenCalled();
  preparation.dispose();
  test.sceneStore.release();
});

it.each(["shape", "none", "scheduler"])("skips preparation for unsupported %s input", (kind) => {
  const test = fixture();
  const ports = kind === "scheduler" ? { store: test.store, sceneStore: test.sceneStore } : test;
  const preparation = new ConnectionPreviewPreparation(
    ports,
    kind === "shape" ? test.shape : kind === "none" ? undefined : test.line,
    test.ready,
  );
  expect(test.prepare).not.toHaveBeenCalled();
  preparation.dispose();
  test.sceneStore.release();
});

it("retains the last immutable materializer while prepared history owns the preview handoff", async () => {
  const elements = connectionChain(300);
  const store = new ElementStore(elements);
  const sceneStore = new ElementSceneStore(store);
  const selected = elements[0]!;
  const connected = new ConnectedSelectionPreviewSession(store, [selected], new Set([selected.id]));
  const preparation = new ConnectionPreviewPreparation(
    { store, sceneStore, scheduler: immediateWorkScheduler() },
    undefined,
    vi.fn(),
  );
  try {
    preparation.prepareConnected(connected, vi.fn());
    await Promise.resolve();
    const preview = connected.update({ kind: "translate", delta: { x: 30, y: 40 } });
    const release = preparation.retainPreview();
    expect(preview.progressive!.materialize(elements[299]!.id)).toMatchObject({
      start: { x: 130, y: 140 },
    });
    release();
    expect(preview.progressive!.materialize(elements[299]!.id)).toBeUndefined();
  } finally {
    preparation.dispose();
    sceneStore.release();
  }
});
