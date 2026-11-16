// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  createPreparedStaticExportSvg,
  createStaticExportSvg,
} from "../../../../../src/obsidian/embeds/export/static-export-svg";
import {
  createExportPage,
  prepareExportDrawing,
} from "../../../../../src/obsidian/embeds/export/export-pages";
import { inspectPreviewSvg } from "../../../../../src/obsidian/embeds/preview/safe-preview-svg";
import { createPreviewSvgAsync } from "../../../../../src/obsidian/embeds/preview/safe-preview-builder";
import { rasterSvg } from "../../../../fixtures/persistence/image-svg";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";

describe("portable raster presentation and native print references", () => {
  it("scopes preview assets and preserves crop geometry while stripping metadata", async () => {
    const source = rasterSvg();
    const options = {
      checkpoint: () => undefined,
      isCancelled: () => false,
      workScheduler: immediateWorkScheduler(),
    };
    const first = await createPreviewSvgAsync(document, source, options);
    const second = await createPreviewSvgAsync(document, source, options);
    expect(first?.querySelector("metadata")).toBeNull();
    expect(first?.querySelector("image")?.id).not.toBe(second?.querySelector("image")?.id);
    for (const svg of [first!, second!]) {
      expect(svg.querySelector("use")?.getAttribute("href")).toBe(
        `#${svg.querySelector("image")?.id}`,
      );
      expect(svg.querySelector("g svg")?.getAttribute("viewBox")).toBe("0 0 1 1");
    }
  });

  it("indexes rotated visible boxes and shares payloads across print pages", async () => {
    const scheduler = immediateWorkScheduler();
    const descriptor = await inspectPreviewSvg(rasterSvg(90), { workScheduler: scheduler });
    expect(descriptor).not.toBeNull();
    const signal = new AbortController().signal;
    const prepared = await createPreparedStaticExportSvg(document, descriptor!, {
      workScheduler: scheduler,
      signal,
    });
    const complete = await createStaticExportSvg(document, descriptor!, {
      workScheduler: scheduler,
      signal,
    });
    expect(prepared?.fragments).toHaveLength(1);
    expect(prepared?.fragments[0]?.minY).toBeCloseTo(150);
    expect(prepared?.fragments[0]?.maxY).toBeCloseTo(350);
    for (const svg of [prepared!.svg, complete!])
      expect(svg.querySelector("use")?.getAttribute("href")).toBe(
        `#${svg.querySelector("image")?.id}`,
      );
    const drawing = await prepareExportDrawing(prepared!.svg, prepared!.fragments, {
      scheduler,
      signal,
    });
    const first = createExportPage(document, drawing, { start: 100, end: 250 });
    const second = createExportPage(document, drawing, { start: 250, end: 400 });
    expect(prepared!.svg.querySelectorAll("image")).toHaveLength(1);
    expect(first.querySelectorAll("image")).toHaveLength(0);
    expect(second.querySelectorAll("image")).toHaveLength(0);
    expect(first.querySelector("use")?.getAttribute("href")).toBe(
      second.querySelector("use")?.getAttribute("href"),
    );
  });
});
