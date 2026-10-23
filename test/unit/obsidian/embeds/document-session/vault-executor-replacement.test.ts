import { expect, it, vi } from "vitest";
import { createVaultExecutorReplacement } from "../../../../../src/obsidian/embeds/document-session/vault-executor-replacement";
import type { DocumentRuntimePort } from "../../../../../src/persistence/worker/runtime/public";
import { createTestDocumentRuntimes } from "../../../../integration/obsidian/embeds/document-session/vault-session-fixtures";

function harness() {
  let disposed = false;
  let fallbackUsed = false;
  const priority = { gestureActive: false, navigationActive: false };
  const candidate = {
    execute: vi.fn<DocumentRuntimePort["execute"]>(),
    terminate: vi.fn(),
    setLiveInputActive: vi.fn(),
    setNavigationActive: vi.fn(),
  };
  const create = vi.fn(async () => candidate);
  const fallback = vi.fn(() => {
    fallbackUsed = true;
    return { execute: vi.fn<DocumentRuntimePort["execute"]>(), terminate: vi.fn() };
  });
  const adopt = vi.fn();
  const replace = createVaultExecutorReplacement({
    identity: { sessionId: "replacement", documentId: "replacement.svg" },
    disposed: () => disposed,
    fallbackUsed: () => fallbackUsed,
    adopt,
    fallback,
    priority,
    runtimes: createTestDocumentRuntimes({
      create,
      createFallback: fallback,
      createStoreScheduler: () => ({
        isCancelled: () => false,
        shouldYield: () => false,
        yieldControl: async () => undefined,
      }),
    }),
  });
  return {
    replace,
    candidate,
    create,
    fallback,
    adopt,
    priority,
    dispose: () => {
      disposed = true;
    },
    useFallback: () => {
      fallbackUsed = true;
    },
  };
}

it("bounds the native retry and fallback for the complete factory lifetime", async () => {
  const fixture = harness();
  fixture.priority.gestureActive = true;
  fixture.priority.navigationActive = true;
  expect(await fixture.replace(2)).toBe(fixture.candidate);
  expect(fixture.create).toHaveBeenCalledExactlyOnceWith("replacement", 2, "replacement.svg");
  expect(fixture.candidate.setLiveInputActive).toHaveBeenCalledWith(true);
  expect(fixture.candidate.setNavigationActive).toHaveBeenCalledWith(true);
  expect(fixture.adopt).toHaveBeenCalledExactlyOnceWith(fixture.candidate, 2);
  expect(await fixture.replace(3)).not.toBe(fixture.candidate);
  await expect(fixture.replace(4)).rejects.toThrow("fallback executor already failed");
  expect(fixture.create).toHaveBeenCalledOnce();
  expect(fixture.fallback).toHaveBeenCalledExactlyOnceWith(3);
});

it("terminates a native candidate if activity initialization fails before adoption", async () => {
  const fixture = harness();
  fixture.candidate.setLiveInputActive.mockImplementation(() => {
    throw new Error("bootstrap controls failed");
  });
  expect(await fixture.replace(2)).not.toBe(fixture.candidate);
  expect(fixture.candidate.terminate).toHaveBeenCalledOnce();
  expect(fixture.adopt).not.toHaveBeenCalled();
  expect(fixture.fallback).toHaveBeenCalledOnce();
});

it.each([false, true])("does not revive a disposed session, late=%s", async (late) => {
  const fixture = harness();
  if (late)
    fixture.create.mockImplementation(async () => {
      fixture.dispose();
      return fixture.candidate;
    });
  else fixture.dispose();
  await expect(fixture.replace(2)).rejects.toThrow("disposed");
  expect(fixture.fallback).not.toHaveBeenCalled();
  expect(fixture.adopt).not.toHaveBeenCalled();
  expect(fixture.candidate.terminate).toHaveBeenCalledTimes(late ? 1 : 0);
});

it("skips native construction after a fallback has already failed", async () => {
  const fixture = harness();
  fixture.useFallback();
  await expect(fixture.replace(2)).rejects.toThrow("fallback executor already failed");
  expect(fixture.create).not.toHaveBeenCalled();
  expect(fixture.fallback).not.toHaveBeenCalled();
});

it.each([false, true])(
  "preserves unused fallback capacity when an operation cancels native construction, success=%s",
  async (success) => {
    const fixture = harness();
    let cancelled = false;
    fixture.create.mockImplementation(async () => {
      cancelled = true;
      if (!success) throw new Error("native construction failed");
      return fixture.candidate;
    });
    await expect(fixture.replace(2, () => cancelled)).rejects.toThrow("cancelled");
    expect(fixture.adopt).not.toHaveBeenCalled();
    expect(fixture.fallback).not.toHaveBeenCalled();
    expect(fixture.candidate.terminate).toHaveBeenCalledTimes(success ? 1 : 0);
    expect(await fixture.replace(3)).not.toBe(fixture.candidate);
    expect(fixture.fallback).toHaveBeenCalledExactlyOnceWith(3);
  },
);
