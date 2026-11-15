// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { prepareNativeTextInkBounds } from "../../../../src/obsidian/text/native-text-ink-bounds";
import { loadBuiltinFont } from "../../../../src/persistence/fonts/builtin-fonts";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import {
  installNativeTextInkHost,
  nativeInkText,
} from "../../../fixtures/obsidian/native-text-ink";

it("bounds real native font ownership and serial loads while measuring a multi-face legacy document", async () => {
  const scheduler = createTestWorkScheduler();
  const resources = [];
  for (const [family, weight, style] of [
    ["inter", 400, "normal"],
    ["inter", 700, "normal"],
    ["inter", 400, "italic"],
    ["inter", 700, "italic"],
    ["source-serif", 400, "normal"],
  ] as const)
    resources.push(await loadBuiltinFont(family, weight, style, scheduler));
  const elements = resources.map((resource, index) => nativeInkText(resource, index + 8));
  elements.push(nativeInkText(resources[0]!, 20));
  const host = installNativeTextInkHost();
  try {
    const result = await prepareNativeTextInkBounds({
      document,
      elements,
      resources,
      scheduler,
      cancelled: () => false,
    });
    expect(result).toHaveLength(elements.length);
    expect(host.created).toHaveLength(6);
    expect(host.maximumLoading()).toBe(1);
    expect(host.maximumRetainedFaces()).toBeLessThanOrEqual(4);
    expect(host.context.measureText).toHaveBeenCalledTimes(6);
    expect(host.retained.size).toBe(0);
    expect(host.canvases).toHaveLength(1);
    expect(host.canvases[0]?.width).toBe(0);
    expect(host.canvases[0]?.height).toBe(0);
  } finally {
    host.dispose();
  }
});
