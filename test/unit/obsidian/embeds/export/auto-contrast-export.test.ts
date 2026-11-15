// @vitest-environment happy-dom

import { expect, it } from "vitest";
import { autoContrastSvg } from "../../../../fixtures/persistence/auto-contrast-svg";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { inspectPreviewSvg } from "../../../../../src/obsidian/embeds/preview/safe-preview-svg";
import { createPreviewSvgAsync } from "../../../../../src/obsidian/embeds/preview/safe-preview-builder";
import {
  createPreparedStaticExportSvg,
  createStaticExportSvg,
} from "../../../../../src/obsidian/embeds/export/static-export-svg";
import { PORTABLE_PALETTE_V1 } from "../../../../../src/domain/schema/public";
import { loadBuiltinFont } from "../../../../../src/persistence/fonts/builtin-fonts";
import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/document-codec";
import { textElement } from "../../../domain/schema/fixtures";
import { createWorkerSnapshot } from "../../../../fixtures/persistence/worker-snapshot";

it.each(["light", "dark"] as const)(
  "keeps contrast references local and the %s export page deterministic",
  async (scheme) => {
    const workScheduler = immediateWorkScheduler();
    const descriptor = await inspectPreviewSvg(autoContrastSvg(), { workScheduler });
    if (descriptor === null) throw new Error("Missing validated contrast preview.");
    const preview = await createPreviewSvgAsync(document, descriptor.safeSvg, {
      workScheduler,
      checkpoint: () => undefined,
      isCancelled: () => false,
    });
    const options = { workScheduler, signal: new AbortController().signal, colorScheme: scheme };
    const complete = await createStaticExportSvg(document, descriptor, options);
    const prepared = await createPreparedStaticExportSvg(document, descriptor, options);
    if (preview === undefined || complete === undefined || prepared === undefined)
      throw new Error("Missing contrast graphic.");
    const roots = [preview, complete, prepared.svg];
    const scoped = roots.map(
      (root) => new Set([...root.querySelectorAll("[id]")].map((node) => node.id)),
    );
    expect([...scoped[0]!].some((id) => scoped[1]!.has(id) || scoped[2]!.has(id))).toBe(false);
    for (const root of roots) {
      const ids = new Set([...root.querySelectorAll("[id]")].map((node) => node.id));
      for (const node of root.querySelectorAll("*")) {
        for (const name of ["href", "filter", "fill", "stroke"]) {
          const value = node.getAttribute(name);
          const id =
            name === "href" && value?.startsWith("#")
              ? value.slice(1)
              : /^url\(#([^)]*)\)$/u.exec(value ?? "")?.[1];
          if (id !== undefined) expect(ids.has(id), `${name}=${value}`).toBe(true);
        }
      }
      expect(root.querySelectorAll('g[id*="inkbook-auto-geometry-"]')).toHaveLength(1);
      for (const filter of root.querySelectorAll("filter")) {
        expect(Number(filter.getAttribute("width"))).toBeLessThanOrEqual(2048);
        expect(Number(filter.getAttribute("height"))).toBeLessThanOrEqual(2048);
      }
      expect(root.querySelector("feImage")).toBeNull();
    }
    for (const root of [complete, prepared.svg]) {
      expect(root.querySelector('[id$="inkbook-auto-underlay"] path')?.getAttribute("fill")).toBe(
        PORTABLE_PALETTE_V1[scheme].page,
      );
      expect(root.querySelector('[id*="inkbook-auto-geometry-"] path')?.getAttribute("fill")).toBe(
        "inherit",
      );
    }
    expect(prepared.fragments.filter((fragment) => !fragment.background)).toHaveLength(2);
  },
);

it("keeps measured version-five text without images on the shared preview and export palette", async () => {
  const workScheduler = immediateWorkScheduler();
  const font = await loadBuiltinFont("inter", 400, "normal", workScheduler);
  const text = textElement();
  text.style.fontFamily = "inter";
  text.layout.lines[0]!.runs[0]!.inkBounds = { minX: 0, minY: -15, maxX: 40, maxY: 5 };
  const output = serializeInkbookDocument({
    ...createWorkerSnapshot([text]),
    version: 5,
    fontResources: [font],
  });
  if (!output.ok) throw new Error(output.error.message);
  const descriptor = await inspectPreviewSvg(output.value.svg, { workScheduler });
  if (descriptor === null) throw new Error("Missing measured text preview.");
  const preview = await createPreviewSvgAsync(document, descriptor.safeSvg, {
    workScheduler,
    checkpoint: () => undefined,
    isCancelled: () => false,
  });
  expect(preview?.querySelector("tspan.inkbook-theme-fill")?.getAttribute("fill")).toBe(
    PORTABLE_PALETTE_V1.light.text,
  );
  expect(preview?.querySelector("pattern, filter, defs")).toBeNull();
  for (const scheme of ["light", "dark"] as const) {
    const options = { workScheduler, signal: new AbortController().signal, colorScheme: scheme };
    const complete = await createStaticExportSvg(document, descriptor, options);
    const prepared = await createPreparedStaticExportSvg(document, descriptor, options);
    for (const root of [complete, prepared?.svg]) {
      expect(root?.querySelector("tspan")?.getAttribute("fill")).toBe(
        PORTABLE_PALETTE_V1[scheme].text,
      );
      expect(root?.querySelector("pattern, filter, defs")).toBeNull();
      expect(root?.querySelector("tspan")?.textContent).toBe("Hello");
    }
    expect(prepared?.fragments.filter((fragment) => !fragment.background)).toHaveLength(1);
  }
});
