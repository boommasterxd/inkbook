import { expect, it, vi } from "vitest";

import * as sampleCopy from "../../../../src/domain/elements/runtime-sample-copy";
import * as sampleValidation from "../../../../src/domain/schema/stroke-sample-range-validation";
import { IncrementalDocumentSerializer } from "../../../../src/persistence/serialization/incremental-document-serializer";
import { FILE_SCHEMA_LIMITS } from "../../../../src/domain/schema/constants";
import {
  createTestStroke,
  createWorkerSnapshot,
} from "../../../fixtures/persistence/worker-snapshot";

function candidate() {
  return createWorkerSnapshot(
    [
      {
        ...createTestStroke(),
        points: Array.from({ length: 4096 }, (_, index) => [index, index % 5, 0.5]).flat(),
      },
    ],
    1,
  );
}

it("rejects an oversized public collection before staging element or sample values", async () => {
  const serializer = new IncrementalDocumentSerializer();
  expect(serializer.resetRuntime(createWorkerSnapshot([createTestStroke()])).ok).toBe(true);
  let elementReads = 0;
  const elements = new Proxy(
    Array.from({ length: FILE_SCHEMA_LIMITS.elements + 1 }, () => createTestStroke()),
    {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) elementReads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    },
  );
  const copy = vi.spyOn(sampleCopy, "copySampleRange");
  try {
    expect(
      await serializer.resetRuntimeSliced(createWorkerSnapshot(elements, 1), {
        signal: new AbortController().signal,
        checkpoint: () => undefined,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "snapshot-invalid", validationError: { code: "element-limit-exceeded" } },
    });
    expect(elementReads).toBe(0);
    expect(copy).not.toHaveBeenCalled();
    expect(serializer.currentRevision()).toBe(0);
  } finally {
    copy.mockRestore();
    serializer.clear();
  }
});

it("preserves adopted fragments when a public unowned full reset is cancelled inside sample copying", async () => {
  const serializer = new IncrementalDocumentSerializer();
  expect(serializer.resetRuntime(createWorkerSnapshot([createTestStroke()])).ok).toBe(true);
  expect((await serializer.serializeRuntimeChunked({})).ok).toBe(true);
  const previous = serializer.instrumentation;
  const controller = new AbortController();
  const copy = vi.spyOn(sampleCopy, "copySampleRange");
  try {
    await expect(
      serializer.resetRuntimeSliced(candidate(), {
        signal: controller.signal,
        checkpoint: () => {
          if (copy.mock.calls.length > 0) controller.abort();
          return undefined;
        },
      }),
    ).rejects.toThrow();
    expect(copy).toHaveBeenCalledOnce();
    expect(copy.mock.calls[0]![3] - copy.mock.calls[0]![2]).toBe(256 * 3);
    expect(serializer.currentRevision()).toBe(0);
    expect(serializer.instrumentation).toMatchObject({
      cacheBytes: previous.cacheBytes,
      cacheElements: 1,
      sampleEncodingCacheBytes: previous.sampleEncodingCacheBytes,
      shapeCacheBytes: previous.shapeCacheBytes,
    });
  } finally {
    copy.mockRestore();
    serializer.clear();
  }
});

it.each(["reset", "delta"] as const)(
  "validates the private unowned %s candidate despite later public mutation",
  async (mode) => {
    const serializer = new IncrementalDocumentSerializer();
    expect(serializer.resetRuntime(createWorkerSnapshot([createTestStroke()])).ok).toBe(true);
    const snapshot = candidate();
    const stroke = snapshot.elements[0]!;
    if (stroke.kind !== "stroke") throw new Error("Expected stroke fixture.");
    const validation = vi.spyOn(sampleValidation, "assertStrokeSampleRange");
    let mutated = false;
    const context = {
      signal: new AbortController().signal,
      checkpoint: () => {
        if (!mutated && validation.mock.calls.length > 0) {
          stroke.points[0] = NaN;
          Object.assign(stroke.style, { width: -1 });
          snapshot.page.activeBufferLines = 99;
          mutated = true;
        }
        return undefined;
      },
    };
    try {
      const updated =
        mode === "reset"
          ? await serializer.resetRuntimeSliced(snapshot, context)
          : await serializer.applyDeltaSliced(
              {
                baseModelRevision: 0,
                modelRevision: 1,
                changedElements: [stroke],
                page: snapshot.page,
              },
              context,
            );
      expect(updated.ok).toBe(true);
      expect(mutated).toBe(true);
      const adopted = serializer.currentSnapshot()!;
      const current = adopted.elements[0]!;
      if (current.kind !== "stroke") throw new Error("Expected adopted stroke.");
      expect(current.points[0]).toBe(0);
      expect(current.style.width).toBe(2);
      expect(adopted.page.activeBufferLines).toBe(3);
      expect((await serializer.serializeRuntimeChunked({})).ok).toBe(true);
    } finally {
      validation.mockRestore();
      serializer.clear();
    }
  },
);
