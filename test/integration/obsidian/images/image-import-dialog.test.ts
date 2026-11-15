// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";
import type { App } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openImageImportDialog } from "../../../../src/obsidian/images/image-import-dialog";
import { Localization } from "../../../../src/domain/localization";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { installDialogTestLifecycle, dialogButton } from "../../../fixtures/obsidian/dialog";
import { assertImageDialogSemantics } from "../../../fixtures/obsidian/image-dialog";
import { capacityImageResource, validImageResource } from "../../../fixtures/persistence/images";
import { IMAGE_LIMITS } from "../../../../src/domain/images/image-limits";
import { ImageImportError } from "../../../../src/obsidian/images/image-import-error";
import { ImageHeaderError } from "../../../../src/persistence/images/image-header";
import { webpBytes } from "../../../fixtures/persistence/webp-images";
import { createImageResource } from "../../../../src/persistence/images/image-resources";

vi.mock("../../../../src/obsidian/images/image-import", async (load) => ({
  ...(await load<object>()),
  readImageSource: vi.fn(async () => new Uint8Array([1])),
  prepareRasterImage: vi.fn(),
}));
vi.mock("../../../../src/obsidian/images/pdf-image-source", () => ({
  openPdfImageSource: vi.fn(),
}));
import { prepareRasterImage, readImageSource } from "../../../../src/obsidian/images/image-import";
import { openPdfImageSource } from "../../../../src/obsidian/images/pdf-image-source";
import type { PdfImageSource } from "../../../../src/obsidian/images/pdf-image-source";

installDialogTestLifecycle();

function setup() {
  const abort = new AbortController();
  const pending = openImageImportDialog({
    app: { workspace: { containerEl: document.body } } as App,
    localization: new Localization(),
    scheduler: new TestWorkScheduler(),
    readMotion: () => "reduced",
    signal: abort.signal,
  });
  return { pending, abort };
}

function selectFile(name = "source.png"): void {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File(["image"], name)],
  });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function beginImageReview() {
  const state = setup();
  selectFile();
  await vi.waitFor(() => expect(dialogButton("Insert").disabled).toBe(false));
  return { ...state, warning: document.querySelector<HTMLElement>('[role="status"]')! };
}

async function beginPdfBatch(
  render: PdfImageSource["render"],
  dispose: PdfImageSource["dispose"] = vi.fn(async () => undefined),
) {
  vi.mocked(readImageSource).mockResolvedValue(new TextEncoder().encode("%PDF-1.7"));
  vi.mocked(openPdfImageSource).mockResolvedValue({ pageCount: 20, render, dispose });
  const state = setup();
  selectFile();
  await vi.waitFor(() => expect(dialogButton("Insert").disabled).toBe(false));
  document.querySelector<HTMLInputElement>('input[type="text"]')!.value = "1-20";
  dialogButton("Insert").click();
  return state;
}

beforeEach(() => vi.clearAllMocks());

describe("image import review", () => {
  it("offers WebP files and reviews the actual selected encoding before insertion", async () => {
    const resource = await createImageResource(webpBytes(), "image/webp", new TestWorkScheduler());
    vi.mocked(readImageSource).mockResolvedValue(webpBytes());
    vi.mocked(prepareRasterImage).mockResolvedValue({ resource });
    const { pending } = setup();
    expect(document.querySelector<HTMLInputElement>('input[type="file"]')!.accept).toContain(
      "image/webp",
    );
    selectFile("drawing.webp");
    await vi.waitFor(() => expect(dialogButton("Insert").disabled).toBe(false));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("WebP");
    expect(document.querySelector("img")?.getAttribute("src")).toContain("data:image/webp;base64,");
    dialogButton("Insert").click();
    expect(await pending).toEqual({ resources: [resource], source: "image" });
    expect(prepareRasterImage).toHaveBeenCalledOnce();
  });

  it("reviews and replaces the selected image before explicit insertion without decoding it twice", async () => {
    const resource = await validImageResource();
    const replacement = await capacityImageResource(1);
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
    expect(dialogButton("source.png · Change").disabled).toBe(false);
    expect(document.querySelector("img")?.getAttribute("src")).toContain(resource.data);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("1 × 1 pixels");
    const choose = vi.spyOn(
      document.querySelector<HTMLInputElement>('input[type="file"]')!,
      "click",
    );
    dialogButton("source.png · Change").click();
    expect(choose).toHaveBeenCalledOnce();
    selectFile("replacement.png");
    await vi.waitFor(() => expect(dialogButton("Insert").disabled).toBe(false));
    expect(dialogButton("replacement.png · Change").disabled).toBe(false);
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
      dispose: vi.fn(async () => undefined),
    });
    selectFile("page.pdf");
    expect(warning.hidden).toBe(true);
    await vi.waitFor(() => expect(dialogButton("Insert").disabled).toBe(false));
    expect(warning.textContent).toBe("");
    dialogButton("Insert").click();
    expect(await pending).toEqual({ resources: [resource], source: "pdf" });
  });
});

describe("image import source ownership", () => {
  it("uses an explicit page range, reuses the current preview and inserts the selected pages in order", async () => {
    const resource = await validImageResource();
    const render = vi.fn(async (_page: number) => resource);
    const dispose = vi.fn(async () => undefined);
    vi.mocked(readImageSource).mockResolvedValue(new TextEncoder().encode("%PDF-1.7"));
    vi.mocked(openPdfImageSource).mockResolvedValue({ pageCount: 5, render, dispose });
    const { pending } = setup();
    selectFile();
    await vi.waitFor(() => expect(dialogButton("Insert").disabled).toBe(false));
    const pages = document.querySelector<HTMLInputElement>('input[type="text"]')!;
    pages.value = "5, 1, 3";
    await assertImageDialogSemantics(["label", "select-name"]);
    dialogButton("Insert").click();
    expect(await pending).toEqual({ resources: [resource, resource, resource], source: "pdf" });
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
    const resource = await validImageResource();
    const render = vi.fn(async (_page: number) => resource);
    vi.mocked(readImageSource).mockResolvedValue(new TextEncoder().encode("%PDF-1.7"));
    vi.mocked(openPdfImageSource).mockResolvedValue({
      pageCount: 5,
      render,
      dispose: vi.fn(async () => undefined),
    });
    const { pending } = setup();
    const file = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const choose = vi.spyOn(file, "click");
    dialogButton("Choose image or PDF").click();
    expect(choose).toHaveBeenCalledOnce();
    selectFile();
    await vi.waitFor(() => expect(dialogButton("Insert").disabled).toBe(false));
    const page = document.querySelector<HTMLInputElement>('input[type="number"]')!;
    page.value = "3";
    page.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() =>
      expect(render).toHaveBeenCalledWith(3, expect.objectContaining({ scale: 2 })),
    );
    await vi.waitFor(() => expect(dialogButton("Insert").disabled).toBe(false));
    const quality = document.querySelector<HTMLSelectElement>("select")!;
    quality.value = "1";
    quality.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() =>
      expect(render).toHaveBeenCalledWith(3, expect.objectContaining({ scale: 1 })),
    );
    await vi.waitFor(() => expect(dialogButton("Insert").disabled).toBe(false));
    document.querySelector<HTMLInputElement>('input[type="text"]')!.value = "0";
    dialogButton("Insert").click();
    await vi.waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toBe(
        new Localization().t("images.failurePages"),
      ),
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
    expect(dialogButton("source.png · Change").disabled).toBe(false);
    expect(document.querySelector("img")?.hasAttribute("src")).toBe(false);
    vi.mocked(prepareRasterImage).mockResolvedValue({ resource });
    selectFile("recovered.png");
    await vi.waitFor(() => expect(dialogButton("Insert").disabled).toBe(false));
    expect(dialogButton("recovered.png · Change").disabled).toBe(false);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("");
    dialogButton("Insert").click();
    expect(await pending).toEqual({ resources: [resource], source: "image" });
  });
});

describe("PDF import batch ownership", () => {
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
      expect(document.querySelector('[role="alert"]')?.textContent).toBe(
        new Localization().t("images.failureCapacity"),
      ),
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
      "Preparing page 2 of 20…",
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
