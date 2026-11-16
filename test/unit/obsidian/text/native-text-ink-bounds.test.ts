// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { prepareNativeTextInkBounds } from "../../../../src/obsidian/text/native-text-ink-bounds";
import { loadBuiltinFont } from "../../../../src/persistence/fonts/builtin-fonts";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import {
  installNativeTextInkHost,
  nativeInkText,
} from "../../../fixtures/obsidian/native-text-ink";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("measures bound saved faces once, preserves layout and disposes native resources", async () => {
  const scheduler = createTestWorkScheduler();
  const resource = await loadBuiltinFont("inter", 400, "normal", scheduler);
  const original = nativeInkText(resource);
  const host = installNativeTextInkHost();
  try {
    const result = await prepareNativeTextInkBounds({
      document,
      resources: [resource],
      elements: [original, nativeInkText(resource, 9)],
      scheduler,
      cancelled: () => false,
    });
    const run = result[0]!.layout.lines[0]!.runs[0]!;
    expect(run).toEqual({
      ...original.layout.lines[0]!.runs[0],
      inkBounds: { minX: -1.6, minY: -20, maxX: 48, maxY: 4 },
    });
    expect(result[0]).toMatchObject({
      x: original.x,
      y: original.y,
      width: original.width,
      height: original.height,
      pivot: original.pivot,
      rotation: original.rotation,
    });
    expect(host.context.font).toContain(`"inkbook-preview-${resource.id}"`);
    expect(host.created).toHaveLength(1);
    expect(host.context.measureText).toHaveBeenCalledOnce();
    expect(host.retained.size).toBe(0);
    expect(host.canvases[0]?.width).toBe(0);
    expect(host.canvases[0]?.height).toBe(0);
    expect(
      await prepareNativeTextInkBounds({
        document,
        resources: [resource],
        elements: result,
        scheduler,
        cancelled: () => false,
      }),
    ).toEqual([]);
    expect(host.created).toHaveLength(1);
    expect(host.canvases).toHaveLength(1);
  } finally {
    host.dispose();
  }
});

it("cleans up a face whose native loading finishes after unlock cancellation", async () => {
  const scheduler = createTestWorkScheduler();
  const resource = await loadBuiltinFont("inter", 400, "normal", scheduler);
  const host = installNativeTextInkHost();
  let release!: () => void;
  host.defer(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  let cancelled = false;
  try {
    const pending = prepareNativeTextInkBounds({
      document,
      resources: [resource],
      elements: [nativeInkText(resource)],
      scheduler,
      cancelled: () => cancelled,
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(host.loading()).toBe(1));
    cancelled = true;
    release();
    await rejected;
    expect(host.retained.size).toBe(0);
    expect(host.canvases).toHaveLength(0);
  } finally {
    host.dispose();
  }
});

it("releases loaded fonts and the canvas when native measurement fails", async () => {
  const scheduler = createTestWorkScheduler();
  const resource = await loadBuiltinFont("inter", 400, "normal", scheduler);
  const host = installNativeTextInkHost();
  host.context.measureText.mockImplementation(() => {
    throw new Error("Native measurement failed.");
  });
  try {
    await expect(
      prepareNativeTextInkBounds({
        document,
        resources: [resource],
        elements: [nativeInkText(resource)],
        scheduler,
        cancelled: () => false,
      }),
    ).rejects.toThrow("Native measurement failed.");
    expect(host.retained.size).toBe(0);
    expect(host.canvases[0]?.width).toBe(0);
    expect(host.canvases[0]?.height).toBe(0);
  } finally {
    host.dispose();
  }
});
