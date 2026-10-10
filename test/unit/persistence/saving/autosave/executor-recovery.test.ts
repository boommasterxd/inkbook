import { describe, expect, it, vi } from "vitest";
import { AutosaveExecutorRecovery } from "../../../../../src/persistence/saving/autosave/executor-recovery";
import type { DocumentRuntimePort } from "../../../../../src/persistence/worker/runtime/public";
import type { AutosaveCoordinatorOptions } from "../../../../../src/persistence/saving/autosave/types";

function executor() {
  return { execute: vi.fn<DocumentRuntimePort["execute"]>(), terminate: vi.fn() };
}

function options(current = executor()) {
  return { current, epoch: 2, disposed: () => false, adopt: vi.fn() };
}

function createRecovery(
  createReplacement: NonNullable<AutosaveCoordinatorOptions["createReplacement"]>,
  disposed: () => boolean,
) {
  const ownership = { ...options(), disposed };
  const recovery = new AutosaveExecutorRecovery({ createReplacement, executor: ownership.current });
  return { ownership, recovery };
}

describe("AutosaveExecutorRecovery ownership", () => {
  it("coalesces simultaneous failures and terminates before starting one replacement", async () => {
    const replacement = executor();
    const ownership = options();
    const createReplacement = vi.fn(async () => {
      expect(ownership.current.terminate).toHaveBeenCalledOnce();
      return replacement;
    });
    const recovery = new AutosaveExecutorRecovery({
      createReplacement,
      executor: ownership.current,
      workerEpoch: 1,
    });
    const first = recovery.recover(ownership);
    expect(recovery.pending).toBe(true);
    expect(recovery.blocksSynchronization(false, "clean")).toBe(true);
    expect(recovery.recover(ownership)).toBe(first);
    expect(await first).toBe(true);
    expect(createReplacement).toHaveBeenCalledExactlyOnceWith(2);
    expect(ownership.adopt).toHaveBeenCalledOnce();
    expect(recovery.executor).toBe(replacement);
    expect(recovery.epoch).toBe(2);
    expect(recovery.pending).toBe(false);
    expect(recovery.blocksSynchronization(false, "clean")).toBe(false);
    expect(recovery.blocksSynchronization(true, "clean")).toBe(true);
    expect(recovery.blocksSynchronization(false, "executor-failed")).toBe(true);
  });

  it("uses the legacy fallback factory at most once", async () => {
    const createFallback = vi.fn(() => executor());
    const recovery = new AutosaveExecutorRecovery({ createFallback, executor: executor() });
    expect(await recovery.recover(options())).toBe(true);
    expect(await recovery.recover(options())).toBe(false);
    expect(createFallback).toHaveBeenCalledOnce();
    expect(await new AutosaveExecutorRecovery({ executor: executor() }).recover(options())).toBe(
      false,
    );
  });

  it.each([false, true])("releases failed construction with disposed=%s", async (disposed) => {
    const createReplacement = vi.fn(async () => {
      throw new Error("bootstrap failed");
    });
    const { recovery, ownership } = createRecovery(createReplacement, () => disposed);
    expect(await recovery.recover(ownership)).toBe(false);
    expect(ownership.adopt).not.toHaveBeenCalled();
    expect(createReplacement).toHaveBeenCalledTimes(disposed ? 0 : 1);
    expect(recovery.pending).toBe(false);
  });

  it("does not start construction when disposal wins the queued bootstrap", async () => {
    let disposed = false;
    const createReplacement = vi.fn(async () => executor());
    const { recovery, ownership } = createRecovery(createReplacement, () => disposed);
    const settling = recovery.recover(ownership);
    disposed = true;
    expect(await settling).toBe(false);
    expect(createReplacement).not.toHaveBeenCalled();
  });

  it("terminates a constructed replacement when disposal wins adoption", async () => {
    let disposed = false;
    const replacement = executor();
    const createReplacement = vi.fn(async () => {
      disposed = true;
      return replacement;
    });
    const { recovery, ownership } = createRecovery(createReplacement, () => disposed);
    expect(await recovery.recover(ownership)).toBe(false);
    expect(replacement.terminate).toHaveBeenCalledOnce();
    expect(ownership.adopt).not.toHaveBeenCalled();
  });
});
