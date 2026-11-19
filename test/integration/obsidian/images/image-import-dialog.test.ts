// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { Localization } from "../../../../src/domain/localization";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { dialogButton } from "../../../fixtures/obsidian/dialog";
import {
  assertImageDialogSemantics,
  imageSourceButton,
} from "../../../fixtures/obsidian/image-dialog";
import { capacityImageResource, validImageResource } from "../../../fixtures/persistence/images";
import { IMAGE_LIMITS } from "../../../../src/domain/images/image-limits";
import { ImageImportError } from "../../../../src/obsidian/images/image-import-error";
import type { ImageImportRequest } from "../../../../src/obsidian/embeds/active-scene/editor-chrome-openings";
import { ImageHeaderError } from "../../../../src/persistence/images/image-header";
import { webpBytes } from "../../../fixtures/persistence/webp-images";
import { createImageResource } from "../../../../src/persistence/images/image-resources";
import { deferredImageSession } from "../../../fixtures/obsidian/image-session";

import {
  beginImageReview,
  beginPdfBatch,
  changeImportField,
  imageImportSubmit,
  imageImportMocks,
  installImageImportTestLifecycle,
  renderImportThumbnail,
  selectImportFile as selectFile,
  setupImageImport as setup,
  setupPdfImport,
} from "../../../fixtures/obsidian/image-import-dialog";

const { prepareRasterImage, readImageSource, openPdfImageSource } = imageImportMocks;
installImageImportTestLifecycle();

describe("image import review", () => {
  it("offers WebP files and reviews the actual selected encoding before insertion", async () => {
    const resource = await createImageResource(webpBytes(), "image/webp", new TestWorkScheduler());
    vi.mocked(readImageSource).mockResolvedValue(webpBytes());
    vi.mocked(prepareRasterImage).mockResolvedValue({ resource });
    const { pending } = setup();
    const placement = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const hint = document.getElementById(placement.getAttribute("aria-describedby")!)!;
    expect(placement.checked).toBe(false);
    expect(hint.textContent).toBe(new Localization().t("images.pageWidthLockedHint"));
    expect(placement.closest("[hidden]")).toBe(hint.closest("[hidden]"));
    expect(hint.closest("[hidden]")).not.toBeNull();
    expect(document.querySelector<HTMLInputElement>('input[type="file"]')!.accept).toContain(
      "image/webp",
    );
    selectFile("drawing.webp");
    await vi.waitFor(() => expect(dialogButton("Insert").disabled).toBe(false));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("WebP");
    expect(document.querySelector("img")?.getAttribute("src")).toContain("data:image/webp;base64,");
    expect(placement.closest("[hidden]")).toBeNull();
    expect(hint.closest("[hidden]")).toBeNull();
    const preview = document.querySelector<HTMLImageElement>(".inkbook-image-import-preview")!;
    const freePlacement = preview.style.transform;
    hint.click();
    expect(placement.checked).toBe(true);
    expect(preview.style.transform).toBe("translateX(0%) scale(1)");
    expect(freePlacement).not.toBe(preview.style.transform);
    expect(document.querySelector<HTMLElement>(".inkbook-placement-lock")!.hidden).toBe(false);
    await assertImageDialogSemantics(["label"]);
    dialogButton("Insert").click();
    expect(await pending).toEqual({
      resources: [resource],
      source: "image",
      placement: "page-width-locked",
    });
    expect(prepareRasterImage).toHaveBeenCalledOnce();
  });

  it("invalidates equal-size raster previews when replacing the selected source", async () => {
    const resource = await capacityImageResource(1);
    const replacement = await capacityImageResource(2);
    vi.mocked(readImageSource).mockResolvedValue(new Uint8Array([1]));
    vi.mocked(prepareRasterImage)
      .mockResolvedValueOnce({ resource })
      .mockResolvedValueOnce({ resource: replacement });
    const { pending } = setup();
    expect(dialogButton("Insert").disabled).toBe(true);
    await assertImageDialogSemantics(["aria-dialog-name"]);
    selectFile();
    await vi.waitFor(() => expect(dialogButton("Insert").disabled).toBe(false));
    expect(document.querySelector<HTMLElement>('[role="status"][hidden]')?.textContent).toBe("");
    const source = imageSourceButton(/^source\.png\s*PNG\s*Change$/);
    expect(source.disabled).toBe(false);
    expect(document.querySelector("img")?.getAttribute("src")).toContain(resource.data);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "2,000 × 2,000 pixels",
    );
    const choose = vi.spyOn(
      document.querySelector<HTMLInputElement>('input[type="file"]')!,
      "click",
    );
    source.click();
    expect(choose).toHaveBeenCalledOnce();
    selectFile("replacement.png");
    await vi.waitFor(() => expect(dialogButton("Insert").disabled).toBe(false));
    expect(imageSourceButton(/^replacement\.png\s*PNG\s*Change$/).disabled).toBe(false);
    expect(document.querySelector("img")?.getAttribute("src")).toContain(replacement.data);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "2,000 × 2,000 pixels",
    );
    dialogButton("Insert").click();
    expect(await pending).toEqual({ resources: [replacement], source: "image" });
    expect(readImageSource).toHaveBeenCalledTimes(2);
    expect(prepareRasterImage).toHaveBeenCalledTimes(2);
  });
});

it("reuses source bytes for Ultra, blocks stale preview insertion on failure and recovers", async () => {
  const standard = await capacityImageResource(1);
  const ultra = await capacityImageResource(2, 4000);
  vi.mocked(prepareRasterImage)
    .mockResolvedValueOnce({ resource: standard, resizedFrom: { width: 5040, height: 5040 } })
    .mockRejectedValueOnce(new ImageImportError("encodedSize", "private"))
    .mockResolvedValueOnce({ resource: ultra });
  const { pending, warning } = await beginImageReview();
  expect(warning.hidden).toBe(false);
  const quality = document.querySelector<HTMLSelectElement>("select")!;
  const change = (value: string) => {
    quality.value = value;
    quality.dispatchEvent(new Event("change", { bubbles: true }));
  };
  change("ultra");
  await vi.waitFor(() => expect(document.querySelector("img")?.hasAttribute("src")).toBe(false));
  expect(dialogButton("Insert").disabled).toBe(true);
  expect(quality.disabled).toBe(false);
  expect(warning.hidden).toBe(true);
  expect(warning.textContent).toBe("");
  change("high");
  await vi.waitFor(() => expect(dialogButton("Insert").disabled).toBe(false));
  expect(warning.hidden).toBe(false);
  expect(prepareRasterImage).toHaveBeenCalledTimes(2);
  change("ultra");
  await vi.waitFor(() => expect(dialogButton("Insert").disabled).toBe(false));
  expect(prepareRasterImage).toHaveBeenLastCalledWith(
    expect.any(Uint8Array),
    expect.objectContaining({ maximumPixels: 16_000_000 }),
  );
  change("ultra");
  dialogButton("Insert").click();
  expect(await pending).toEqual({ resources: [ultra], source: "image" });
  expect(prepareRasterImage).toHaveBeenCalledTimes(3);
  expect(readImageSource).toHaveBeenCalledOnce();
});

describe("image downscale review", () => {
  it("announces downscaling and inserts the reviewed resource without another decode", async () => {
    const resource = await capacityImageResource(1);
    vi.mocked(readImageSource).mockResolvedValue(new Uint8Array([1]));
    vi.mocked(prepareRasterImage).mockResolvedValue({
      resource,
      resizedFrom: { width: 5040, height: 5040 },
    });
    const { pending, warning } = await beginImageReview();
    expect(warning.hidden).toBe(false);
    expect(warning.textContent).toBe(
      new Localization().t("images.resized", {
        sourceWidth: 5040,
        sourceHeight: 5040,
        width: 2000,
        height: 2000,
      }),
    );
    dialogButton("Insert").click();
    expect(await pending).toEqual({ resources: [resource], source: "image" });
    expect(prepareRasterImage).toHaveBeenCalledOnce();
    expect(readImageSource).toHaveBeenCalledOnce();
  });

  it("clears a downscale warning when replacing the source, including errors and PDF pages", async () => {
    const resource = await capacityImageResource(1);
    const small = await validImageResource();
    vi.mocked(readImageSource).mockResolvedValue(new Uint8Array([1]));
    vi.mocked(prepareRasterImage)
      .mockResolvedValueOnce({ resource, resizedFrom: { width: 5040, height: 5040 } })
      .mockRejectedValueOnce(new ImageImportError("decode", "private"))
      .mockResolvedValueOnce({ resource, resizedFrom: { width: 5040, height: 5040 } })
      .mockResolvedValueOnce({ resource: small });
    const { pending, warning } = await beginImageReview();
    expect(warning.hidden).toBe(false);
    selectFile("broken.png");
    expect(warning.hidden).toBe(true);
    await vi.waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).not.toBe(""),
    );
    expect(warning.textContent).toBe("");
    selectFile("large.png");
    await vi.waitFor(() => expect(warning.hidden).toBe(false));
    selectFile("small.png");
    expect(warning.hidden).toBe(true);
    await vi.waitFor(() => expect(dialogButton("Insert").disabled).toBe(false));
    expect(warning.textContent).toBe("");
    vi.mocked(prepareRasterImage).mockResolvedValueOnce({
      resource,
      resizedFrom: { width: 5040, height: 5040 },
    });
    selectFile("large.png");
    await vi.waitFor(() => expect(warning.hidden).toBe(false));
    vi.mocked(readImageSource).mockResolvedValue(new TextEncoder().encode("%PDF-1.7"));
    vi.mocked(openPdfImageSource).mockResolvedValue({
      pageCount: 1,
      render: vi.fn(async () => resource),
      renderThumbnail: renderImportThumbnail,
      dispose: vi.fn(async () => undefined),
    });
    selectFile("page.pdf");
    expect(warning.hidden).toBe(true);
    await vi.waitFor(() => expect(imageImportSubmit().disabled).toBe(false));
    expect(warning.textContent).toBe("");
    imageImportSubmit().click();
    expect(await pending).toEqual({ resources: [resource], source: "pdf" });
  });
});

describe("image import source ownership", () => {
  it.each([
    ["very-high", 300, 9_000_000],
    ["ultra", 400, 16_000_000],
  ] as const)(
    "reviews %s PDF resolution with actual DPI and reuses the matching page on insertion",
    async (quality, dpi, maximumPixels) => {
      const resource = await capacityImageResource(1, 4000);
      const render = vi.fn(async () => resource);
      vi.mocked(readImageSource).mockResolvedValue(new TextEncoder().encode("%PDF-1.7"));
      vi.mocked(openPdfImageSource).mockResolvedValue({
        pageCount: 1,
        render,
        renderThumbnail: renderImportThumbnail,
        dispose: vi.fn(async () => undefined),
        resolution: { page: 1, dpi: 250, limited: true },
      });
      const { pending } = setup();
      selectFile();
      await vi.waitFor(() => expect(imageImportSubmit().disabled).toBe(false));
      const select = document.querySelector<HTMLSelectElement>("select")!;
      select.value = quality;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await vi.waitFor(() => expect(imageImportSubmit().disabled).toBe(false));
      expect(render).toHaveBeenLastCalledWith(
        1,
        expect.objectContaining({ scale: dpi / 72, maximumPixels }),
      );
      expect(document.querySelector("figcaption")?.textContent).toContain("approx. 250 dpi");
      expect(document.querySelector(".inkbook-image-import-resize-warning")?.textContent).toBe(
        new Localization().t("images.pdfResolutionLimited", { dpi: 250 }),
      );
      imageImportSubmit().click();
      expect(await pending).toEqual({ resources: [resource], source: "pdf" });
      expect(render).toHaveBeenCalledTimes(2);
      expect(readImageSource).toHaveBeenCalledOnce();
    },
  );

  it("uses an explicit page range, reuses the current preview and inserts the selected pages in order", async () => {
    const { resource, render, dispose, pending } = await setupPdfImport();
    selectFile();
    await vi.waitFor(() => expect(imageImportSubmit().disabled).toBe(false));
    const pages = document.querySelector<HTMLInputElement>('input[type="text"]')!;
    changeImportField(pages, "5, 1, 3");
    document.querySelector<HTMLInputElement>(".inkbook-image-import-placement input")!.click();
    await assertImageDialogSemantics(["label", "select-name"]);
    imageImportSubmit().click();
    expect(await pending).toEqual({
      resources: [resource, resource, resource],
      source: "pdf",
      placement: "page-width-locked",
    });
    expect(render.mock.calls.map((args) => args[0])).toEqual([1, 3, 5]);
    expect(readImageSource).toHaveBeenCalledOnce();
    expect(openPdfImageSource).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalled();
  });

  it("discards a pending decode on owner cancellation without accepting its late result", async () => {
    vi.mocked(readImageSource).mockResolvedValue(new Uint8Array([1]));
    let finish!: (resource: Awaited<ReturnType<typeof prepareRasterImage>>) => void;
    vi.mocked(prepareRasterImage).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { pending, abort } = setup();
    selectFile();
    await vi.waitFor(() => expect(prepareRasterImage).toHaveBeenCalled());
    expect(document.querySelector(".inkbook-image-import-body")?.getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(document.querySelector<HTMLElement>(".inkbook-image-import-source-name")?.hidden).toBe(
      true,
    );
    expect(document.querySelector(".inkbook-image-import-source-hint")?.textContent).toBe(
      "Preparing image…",
    );
    expect(
      document
        .querySelector<HTMLElement>('[role="status"]:not([hidden])')
        ?.closest('[aria-busy="true"]'),
    ).toBeNull();
    expect(dialogButton("Insert").disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true);
    expect(dialogButton("Cancel").disabled).toBe(false);
    abort.abort();
    expect(await pending).toBeUndefined();
    finish({ resource: await validImageResource() });
    await Promise.resolve();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("import preview and recovery", () => {
  it("previews an explicitly chosen PDF page and resolution and recovers from an invalid page range", async () => {
    const { render, pending } = await setupPdfImport();
    const file = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const choose = vi.spyOn(file, "click");
    imageSourceButton(/^Choose image or PDF\s*PNG, JPG, WebP or PDF · Up to 16 MiB/).click();
    expect(choose).toHaveBeenCalledOnce();
    selectFile();
    await vi.waitFor(() => expect(imageImportSubmit().disabled).toBe(false));
    const page = document.querySelector<HTMLInputElement>('[aria-label="Preview page"]')!;
    expect(page.max).toBe("5");
    page.value = "3";
    page.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() =>
      expect(render).toHaveBeenCalledWith(3, expect.objectContaining({ scale: 2 })),
    );
    await vi.waitFor(() => expect(imageImportSubmit().disabled).toBe(false));
    const quality = document.querySelector<HTMLSelectElement>("select")!;
    quality.value = "standard";
    quality.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() =>
      expect(render).toHaveBeenCalledWith(3, expect.objectContaining({ scale: 1 })),
    );
    await vi.waitFor(() => expect(imageImportSubmit().disabled).toBe(false));
    changeImportField(document.querySelector<HTMLInputElement>('input[type="text"]')!, "0");
    expect(imageImportSubmit().disabled).toBe(true);
    await vi.waitFor(() =>
      expect(document.querySelector('input[type="text"]')?.getAttribute("aria-invalid")).toBe(
        "true",
      ),
    );
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent),
      ).toContain(new Localization().t("images.failurePages")),
    );
    dialogButton("Cancel").click();
    expect(await pending).toBeUndefined();
  });

  it.each([
    [new ImageHeaderError("dimensions"), "images.failureDimensions"],
    [new ImageHeaderError("format"), "images.failureFormat"],
    [new ImageImportError("decode", "private native exception"), "images.failureDecode"],
    [new Error("unexpected private exception"), "images.failure"],
  ] as const)("reports %s and recovers when a valid source is chosen", async (error, message) => {
    const resource = await validImageResource();
    vi.mocked(readImageSource).mockResolvedValue(new Uint8Array([1]));
    vi.mocked(prepareRasterImage).mockRejectedValueOnce(error);
    const { pending } = setup();
    selectFile();
    await vi.waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toBe(
        new Localization().t(message),
      ),
    );
    expect(dialogButton("Insert").disabled).toBe(true);
    expect(
      imageSourceButton(/^source\.png\s*PNG, JPG, WebP or PDF · Up to 16 MiB\s*Change$/).disabled,
    ).toBe(false);
    expect(document.querySelector("img")?.hasAttribute("src")).toBe(false);
    vi.mocked(prepareRasterImage).mockResolvedValue({ resource });
    selectFile("recovered.png");
    await vi.waitFor(() => expect(dialogButton("Insert").disabled).toBe(false));
    expect(imageSourceButton(/^recovered\.png\s*PNG\s*Change$/).disabled).toBe(false);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("");
    dialogButton("Insert").click();
    expect(await pending).toEqual({ resources: [resource], source: "image" });
  });
});

describe("PDF import batch ownership", () => {
  it("defers to final admission if the retained snapshot becomes unavailable and reuses pages on retry", async () => {
    const admission = deferredImageSession<"capacity">();
    const full = await Promise.all([
      capacityImageResource(1, 4000),
      capacityImageResource(2, 4000),
    ]);
    const retained = vi
      .fn<NonNullable<ImageImportRequest["retainedResources"]>>()
      .mockReturnValueOnce(full)
      .mockReturnValue(undefined);
    const { pending, render, dispose, submit, resource } = await setupPdfImport(
      3,
      (batch) => (batch.resources.length === 3 ? admission.promise : Promise.resolve("committed")),
      retained,
    );
    selectFile("review.pdf");
    await vi.waitFor(() => expect(imageImportSubmit().disabled).toBe(false));
    imageImportSubmit().click();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(retained).toHaveBeenCalledTimes(2);
    expect(imageImportSubmit().disabled).toBe(true);
    expect(dialogButton("Cancel").disabled).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
    imageImportSubmit().click();
    expect(submit).toHaveBeenCalledOnce();
    admission.resolve("capacity");
    await vi.waitFor(() => expect(imageImportSubmit().disabled).toBe(false));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      new Localization().t("images.failureCapacity"),
    );
    const pages = document.querySelector<HTMLInputElement>('input[type="text"]')!;
    changeImportField(pages, "1,3");
    imageImportSubmit().click();
    expect(await pending).toEqual({ resources: [resource, resource], source: "pdf" });
    expect(render.mock.calls.map(([page]) => page)).toEqual([1, 2, 3]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("stops rasterizing when the next distinct page exceeds the total decoded pixel capacity", async () => {
    const resource = await validImageResource();
    const render = vi.fn(async (page: number) => ({
      ...resource,
      id: page.toString(16).padStart(64, "0"),
      width: 2000,
      height: 2000,
    }));
    const { pending } = await beginPdfBatch(render);
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent),
      ).toContain(new Localization().t("images.failureCapacity")),
    );
    expect(render.mock.calls.map(([page]) => page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    dialogButton("Cancel").click();
    expect(await pending).toBeUndefined();
  });

  it("counts duplicate page rasters once for both bytes and pixels while retaining all requested placements", async () => {
    const resource = {
      ...(await validImageResource()),
      width: 2000,
      height: 2000,
      data: "A".repeat(Math.ceil(IMAGE_LIMITS.resourceBytes / 3) * 4 - 4),
    };
    const render = vi.fn(async (_page: number) => ({ ...resource }));
    const { pending } = await beginPdfBatch(render);
    const result = await pending;
    expect(result?.source).toBe("pdf");
    expect(result?.resources).toHaveLength(20);
    expect(result!.resources.every((image) => image === result!.resources[0])).toBe(true);
    expect(render).toHaveBeenCalledTimes(20);
  });

  it("does not start another page after cancellation during rasterization", async () => {
    const resource = await validImageResource();
    let finish!: (value: typeof resource) => void;
    const render = vi.fn(async (page: number) =>
      page === 1
        ? resource
        : new Promise<typeof resource>((resolve) => {
            finish = resolve;
          }),
    );
    const dispose = vi.fn(async () => undefined);
    const { pending, abort } = await beginPdfBatch(render, dispose);
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    expect(document.querySelector(".inkbook-image-import-source-hint")?.textContent).toBe(
      "Preparing PDF page 2 (2 of 20)…",
    );
    abort.abort();
    expect(await pending).toBeUndefined();
    finish(resource);
    await Promise.resolve();
    await Promise.resolve();
    expect(render.mock.calls.map(([page]) => page)).toEqual([1, 2]);
    expect(dispose).toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
