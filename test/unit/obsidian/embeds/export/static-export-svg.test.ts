// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { PORTABLE_PALETTE_V1 } from "../../../../../src/domain/schema/public";
import {
  createPreparedStaticExportSvg,
  createStaticExportSvg,
} from "../../../../../src/obsidian/embeds/export/static-export-svg";
import { createPreviewSvgAsync } from "../../../../../src/obsidian/embeds/preview/safe-preview-builder";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { validatedPreview } from "../../../../fixtures/obsidian/markdown-export";
import { serializeSvgEnvelope } from "../../../../../src/persistence/documents/svg-envelope";
import { createWorkerSnapshot } from "../../../../fixtures/persistence/worker-snapshot";

it("builds identical retained text typography and embedded font rules through cold and warm export paths", async () => {
  const descriptor = await validatedPreview();
  const stylesheet =
    '@font-face{font-family:"inkbook-example";font-style:normal;font-weight:400;src:url("data:font/woff2;base64,AA==") format("woff2")}';
  const text = `<text xml:space="preserve" transform="rotate(15 100 200)"><tspan x="100" y="200" textLength="320.125" lengthAdjust="spacingAndGlyphs" font-family="inkbook-example" font-size="24" font-weight="400" font-style="italic" text-decoration="underline line-through" class="inkbook-theme-fill" fill="${PORTABLE_PALETTE_V1.light.text}" fill-opacity="0.5">  Résumé   &amp; &lt;math&gt;  </tspan></text>`;
  const safeSvg = serializeSvgEnvelope({ ...createWorkerSnapshot([]), version: 2 }, 1000, {
    background: [],
    highlights: [],
    content: [text],
  }).replace("<metadata ", `<style id="inkbook-fonts">${stylesheet}</style><metadata `);
  const options = {
    workScheduler: immediateWorkScheduler(),
    signal: new AbortController().signal,
    colorScheme: "dark" as const,
  };
  const prepared = await createPreparedStaticExportSvg(
    document,
    { ...descriptor, safeSvg },
    options,
  );
  const complete = await createStaticExportSvg(document, { ...descriptor, safeSvg }, options);
  expect(prepared?.svg.outerHTML).toBe(complete?.outerHTML);
  expect(prepared?.fragments).toEqual([{ minY: -Infinity, maxY: Infinity, background: false }]);
  const span = complete?.querySelector("text tspan");
  expect(span?.textContent).toBe("  Résumé   & <math>  ");
  for (const svg of [prepared!.svg, complete!])
    expect(
      svg.querySelector("text")!.getAttributeNS("http://www.w3.org/XML/1998/namespace", "space"),
    ).toBe("preserve");
  expect(span?.getAttribute("fill")).toBe(PORTABLE_PALETTE_V1.dark.text);
  expect(span?.getAttribute("font-family")).toBe("inkbook-example");
  expect(span?.getAttribute("text-decoration")).toBe("underline line-through");
  expect(span?.getAttribute("textLength")).toBe("320.125");
  expect(span?.getAttribute("lengthAdjust")).toBe("spacingAndGlyphs");
  expect(complete?.querySelectorAll("text tspan")).toHaveLength(1);
  expect(complete?.querySelector("path")).toBeNull();
  expect(complete?.querySelector("text")?.getAttribute("transform")).toBe("rotate(15 100 200)");
  expect(complete?.querySelector("style")?.textContent).toBe(stylesheet);
  expect(complete?.querySelector("metadata")).toBeNull();
});

describe("static export SVG", () => {
  it.each(["light", "dark"] as const)(
    "preserves the complete graphic and opacity with the %s palette",
    async (scheme) => {
      const descriptor = await validatedPreview();
      const preview = await createPreviewSvgAsync(document, descriptor.safeSvg, {
        checkpoint: () => undefined,
        isCancelled: () => false,
        workScheduler: immediateWorkScheduler(),
      });
      const svg = await createStaticExportSvg(document, descriptor, {
        workScheduler: immediateWorkScheduler(),
        signal: new AbortController().signal,
        description: "  Lecture notes  ",
        ...(scheme === "dark" ? { colorScheme: scheme } : {}),
      });
      const prepared = await createPreparedStaticExportSvg(document, descriptor, {
        workScheduler: immediateWorkScheduler(),
        signal: new AbortController().signal,
        description: "Lecture notes",
        colorScheme: scheme,
      });
      if (svg === undefined || preview === undefined) throw new Error("Missing export graphic.");

      expect(prepared?.svg.outerHTML).toBe(svg.outerHTML);
      expect(prepared?.fragments).toHaveLength(svg.querySelectorAll("path").length);
      expect(svg.isConnected).toBe(false);
      expect(svg.getAttribute("viewBox")).toBe(preview.getAttribute("viewBox"));
      expect(svg.getAttribute("role")).toBe("img");
      expect(svg.getAttribute("aria-label")).toBe("Lecture notes");
      expect(svg.getAttribute("focusable")).toBe("false");
      expect(svg.hasAttribute("aria-hidden")).toBe(false);
      expect(svg.hasAttribute("class")).toBe(false);
      expect(svg.querySelector("style, metadata, [class], [id]")).toBeNull();
      const sourcePaths = [...preview.querySelectorAll("path")];
      const exportPaths = [...svg.querySelectorAll("path")];
      expect(exportPaths).toHaveLength(sourcePaths.length);
      for (const [index, source] of sourcePaths.entries()) {
        const exported = exportPaths[index];
        expect(exported?.getAttribute("d")).toBe(source.getAttribute("d"));
        for (const name of ["fill-opacity", "stroke-opacity", "stroke-width", "transform"]) {
          expect(exported?.getAttribute(name)).toBe(source.getAttribute(name));
        }
        assertPortablePaint(source, exported, scheme);
      }
      expect([...svg.querySelectorAll("g")].map((group) => group.getAttribute("opacity"))).toEqual(
        [...preview.querySelectorAll("g")].map((group) => group.getAttribute("opacity")),
      );
      expect(svg.querySelector('[stroke="#FFFF0080"]')).not.toBeNull();
    },
  );

  it("provides a meaningful fallback description", async () => {
    const svg = await createStaticExportSvg(document, await validatedPreview(), {
      workScheduler: immediateWorkScheduler(),
      signal: new AbortController().signal,
      description: " ",
    });
    expect(svg?.getAttribute("aria-label")).toBe("Handwriting");
  });

  it("keeps band ordinals, painted translations and opacity while flattening only neutral groups", async () => {
    const descriptor = await validatedPreview();
    const path = '<path d="M0 100 L10 110" fill="none" stroke="#112233FF" stroke-width="2"/>';
    const safeSvg = serializeSvgEnvelope(createWorkerSnapshot([]), 1000, {
      background: [path],
      highlights: [`<g opacity="0.5">${path}</g>`],
      content: [
        `<g opacity="1">${path}</g>`,
        `<g opacity="1" transform="translate(10 200)">${path}</g>`,
        `<g transform="translate(-10 -50)">${path}</g>`,
      ],
    });
    const prepared = await createPreparedStaticExportSvg(
      document,
      { ...descriptor, safeSvg },
      {
        workScheduler: immediateWorkScheduler(),
        signal: new AbortController().signal,
      },
    );
    expect(prepared?.fragments).toEqual([
      { minY: 96, maxY: 114, background: true },
      { minY: 96, maxY: 114, background: false },
      { minY: 96, maxY: 114, background: false },
      { minY: 296, maxY: 314, background: false },
      { minY: 46, maxY: 64, background: false },
    ]);
    const bands = prepared?.svg.children;
    expect(bands).toHaveLength(3);
    expect(bands?.[0]?.querySelectorAll("path")).toHaveLength(1);
    expect(bands?.[1]?.firstElementChild?.getAttribute("opacity")).toBe("0.5");
    expect(bands?.[2]?.children).toHaveLength(3);
    expect(bands?.[2]?.children[0]?.localName).toBe("path");
    expect(bands?.[2]?.children[1]?.getAttribute("transform")).toBe("translate(10 200)");
    expect(bands?.[2]?.children[2]?.getAttribute("transform")).toBe("translate(-10 -50)");
    expect(prepared?.svg.querySelectorAll("path")).toHaveLength(5);
  });
});

describe("static export SVG cancellation and malformed boundaries", () => {
  it.each([
    ["DOM-only", createStaticExportSvg],
    ["fused", createPreparedStaticExportSvg],
  ] as const)(
    "does no DOM work for an already cancelled export through %s",
    async (_name, build) => {
      const descriptor = await validatedPreview();
      const controller = new AbortController();
      controller.abort();
      const create = vi.spyOn(document, "createElementNS");
      try {
        await expect(
          build(document, descriptor, {
            workScheduler: immediateWorkScheduler(),
            signal: controller.signal,
          }),
        ).resolves.toBeUndefined();
        expect(create).not.toHaveBeenCalled();
      } finally {
        create.mockRestore();
      }
    },
  );

  it.each([
    ["DOM-only", createStaticExportSvg],
    ["fused", createPreparedStaticExportSvg],
  ] as const)(
    "keeps partial work detached and drops it when cancellation interrupts %s",
    async (_name, build) => {
      const descriptor = await validatedPreview();
      const controller = new AbortController();
      const create = vi.spyOn(document, "createElementNS");
      const scheduler = immediateWorkScheduler(() => create.mock.calls.length > 0);
      const checkpoint = vi.fn(() => {
        if (create.mock.calls.length === 0) return undefined;
        controller.abort();
        return Promise.reject(new Error("Export cancelled."));
      });
      try {
        await expect(
          build(document, descriptor, {
            workScheduler: { ...scheduler, checkpoint },
            signal: controller.signal,
          }),
        ).resolves.toBeUndefined();
        expect(create).toHaveBeenCalled();
        for (const result of create.mock.results) {
          expect((result.value as Element).isConnected).toBe(false);
        }
        expect(checkpoint).toHaveBeenLastCalledWith(controller.signal, "background");
      } finally {
        create.mockRestore();
      }
    },
  );

  it("rejects malformed boundary markup without publishing partial SVG or unsafe resources", async () => {
    const descriptor = await validatedPreview();
    const create = vi.spyOn(document, "createElementNS");
    try {
      for (const safeSvg of [
        descriptor.safeSvg.replace("<svg ", '<svg onload="unexpected()" '),
        descriptor.safeSvg.replace('id="inkbook-content"', 'id="unexpected"'),
        descriptor.safeSvg.replace("</svg>", ""),
        descriptor.safeSvg.replace("<path ", '<path href="https://unexpected.invalid/image" '),
      ]) {
        await expect(
          createPreparedStaticExportSvg(
            document,
            { ...descriptor, safeSvg },
            {
              workScheduler: immediateWorkScheduler(),
              signal: new AbortController().signal,
            },
          ),
        ).resolves.toBeUndefined();
      }
      for (const result of create.mock.results) {
        const element = result.value as Element;
        expect(element.isConnected).toBe(false);
        expect(element.hasAttribute("onload")).toBe(false);
        expect(element.hasAttribute("href")).toBe(false);
      }
    } finally {
      create.mockRestore();
    }
  });
});

function assertPortablePaint(
  source: SVGPathElement,
  exported: SVGPathElement | undefined,
  scheme: "light" | "dark",
): void {
  const palette = PORTABLE_PALETTE_V1[scheme];
  const theme = source.getAttribute("class");
  const expectedFill = new Map([
    ["inkbook-theme-page", palette.page],
    ["inkbook-theme-fill", palette.text],
    ["inkbook-theme-stroke-fill", palette.text],
  ]);
  const expectedStroke = new Map([
    ["inkbook-theme-guide", palette.guide],
    ["inkbook-theme-stroke", palette.text],
    ["inkbook-theme-stroke-fill", palette.text],
  ]);
  expect(exported?.getAttribute("fill")).toBe(
    expectedFill.get(theme ?? "") ?? source.getAttribute("fill"),
  );
  expect(exported?.getAttribute("stroke")).toBe(
    expectedStroke.get(theme ?? "") ?? source.getAttribute("stroke"),
  );
  if (theme === "inkbook-theme-guide") {
    expect(exported?.getAttribute("vector-effect")).toBe("non-scaling-stroke");
  }
}
