// @vitest-environment happy-dom
import { Platform } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { Localization } from "../../../../src/domain/localization";
import { dialogButton } from "../../../fixtures/obsidian/dialog";
import { deferredImageSession } from "../../../fixtures/obsidian/image-session";
import { capacityImageResource, validImageResource } from "../../../fixtures/persistence/images";
import {
  changeImportField,
  imageImportSubmit,
  imageImportMocks,
  installImageImportTestLifecycle,
  selectImportFile,
  setupImageImport,
  setupPdfImport,
} from "../../../fixtures/obsidian/image-import-dialog";

const { prepareRasterImage, readImageSource, openPdfImageSource } = imageImportMocks;
installImageImportTestLifecycle();

async function beginPdfReview(pageCount = 5) {
  const state = await setupPdfImport(pageCount);
  selectImportFile("pages.pdf");
  const selected = Math.min(pageCount, 20);
  await vi.waitFor(() =>
    expect(dialogButton(`Insert ${selected} ${selected === 1 ? "page" : "pages"}`).disabled).toBe(
      false,
    ),
  );
  const range = document.querySelector<HTMLInputElement>('input[type="text"]')!;
  const page = document.querySelector<HTMLInputElement>('[aria-label="Preview page"]')!;
  return { ...state, range, page };
}

async function reviewedPage(render: ReturnType<typeof vi.fn>, page: number): Promise<void> {
  await vi.waitFor(() => {
    expect(render).toHaveBeenLastCalledWith(page, expect.anything());
    expect(imageImportSubmit().disabled).toBe(false);
  });
}

function fieldAlert(field: HTMLInputElement): HTMLElement {
  const id = field.getAttribute("aria-describedby")!;
  const alert = document.getElementById(id)!;
  expect(alert.getAttribute("role")).toBe("alert");
  return alert;
}

it("keeps the PDF review stable while rapid navigation supersedes a pending render", async () => {
  const { resource, render, dispose, pending, abort } = await setupPdfImport(5);
  selectImportFile("pages.pdf");
  await vi.waitFor(() => expect(imageImportSubmit().disabled).toBe(false));
  const preview = document.querySelector("img")!;
  const source = preview.getAttribute("src");
  const replacement = await capacityImageResource(42);
  const slow = deferredImageSession<typeof resource>();
  const latest = deferredImageSession<typeof resource>();
  render.mockReturnValueOnce(slow.promise).mockReturnValueOnce(latest.promise);
  const next = dialogButton("Next page");
  next.focus();
  next.click();
  next.click();
  next.click();
  expect(preview.getAttribute("src")).toBe(source);
  expect(preview.closest("figure")!.hidden).toBe(false);
  expect(document.querySelector<HTMLFieldSetElement>("fieldset")!.hidden).toBe(false);
  expect(document.activeElement).toBe(next);
  const sourceButton = dialogButton("pages.pdf · Change");
  expect(sourceButton.textContent).toContain("Change");
  expect(sourceButton.querySelector<HTMLElement>(".inkbook-image-import-replace")?.hidden).toBe(
    false,
  );
  expect(render.mock.calls.map(([page]) => page)).toEqual([1, 2]);
  expect(imageImportSubmit().disabled).toBe(true);
  expect(dialogButton("Cancel").disabled).toBe(false);
  slow.resolve(await capacityImageResource(41));
  await vi.waitFor(() => expect(render.mock.calls.map(([page]) => page)).toEqual([1, 2, 4]));
  expect(preview.getAttribute("src")).toBe(source);
  latest.resolve(replacement);
  await vi.waitFor(() => expect(imageImportSubmit().disabled).toBe(false));
  expect(preview.getAttribute("src")).toContain(replacement.data);
  const resized = deferredImageSession<typeof resource>();
  render.mockReturnValueOnce(resized.promise);
  const quality = document.querySelector<HTMLSelectElement>("select")!;
  quality.value = "ultra";
  quality.dispatchEvent(new Event("change", { bubbles: true }));
  expect(preview.getAttribute("src")).toContain(replacement.data);
  expect(imageImportSubmit().disabled).toBe(true);
  abort.abort();
  expect(await pending).toBeUndefined();
  resized.resolve(resource);
  await Promise.resolve();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(dispose).toHaveBeenCalled();
  expect(readImageSource).toHaveBeenCalledOnce();
  expect(render.mock.calls.map(([page]) => page)).toEqual([1, 2, 4, 4]);
});

describe("PDF import selection and reviewed output", () => {
  it("counts a range while typing, reviews its first page on commit and reuses it when inserting", async () => {
    const state = await beginPdfReview();
    state.range.value = "3-5";
    state.range.dispatchEvent(new Event("input", { bubbles: true }));
    expect(dialogButton("Insert 3 pages").disabled).toBe(false);
    expect(state.page.value).toBe("1");
    expect(state.render).toHaveBeenCalledOnce();
    state.range.dispatchEvent(new Event("change", { bubbles: true }));
    await reviewedPage(state.render, 3);
    expect(state.page.value).toBe("3");
    changeImportField(state.range, "3-5");
    expect(state.render).toHaveBeenCalledTimes(2);
    dialogButton("Insert 3 pages").click();
    expect(await state.pending).toEqual({
      source: "pdf",
      resources: [state.resource, state.resource, state.resource],
    });
    expect(state.render.mock.calls.map(([page]) => page)).toEqual([1, 3, 4, 5]);
    expect(readImageSource).toHaveBeenCalledOnce();
    expect(openPdfImageSource).toHaveBeenCalledOnce();
  });

  it("freely browses unselected pages with bounded Previous/Next actions without changing import selection", async () => {
    const state = await beginPdfReview();
    changeImportField(state.range, "1");
    expect(dialogButton("Previous page").disabled).toBe(true);
    dialogButton("Next page").click();
    await reviewedPage(state.render, 2);
    expect(state.range.value).toBe("1");
    expect(dialogButton("Insert 1 page").disabled).toBe(false);
    state.page.focus();
    changeImportField(state.page, "5");
    await reviewedPage(state.render, 5);
    expect(document.activeElement).toBe(state.page);
    expect(dialogButton("Next page").disabled).toBe(true);
    dialogButton("Previous page").click();
    await reviewedPage(state.render, 4);
    expect(state.range.value).toBe("1");
    changeImportField(state.page, "1");
    await vi.waitFor(() => expect(imageImportSubmit().disabled).toBe(false));
    expect(state.page.value).toBe("1");
    dialogButton("Insert 1 page").click();
    expect(await state.pending).toEqual({ source: "pdf", resources: [state.resource] });
    expect(state.render.mock.calls.map(([page]) => page)).toEqual([1, 2, 5, 4]);
    expect(readImageSource).toHaveBeenCalledOnce();
  });

  it("imports the single reviewed page without exposing irrelevant range or navigation controls", async () => {
    const state = await beginPdfReview(1);
    expect(state.range.closest("fieldset")!.hidden).toBe(true);
    expect(
      state.page.closest<HTMLElement>(".inkbook-image-import-preview-navigation")!.hidden,
    ).toBe(true);
    dialogButton("Insert 1 page").click();
    expect(await state.pending).toEqual({ source: "pdf", resources: [state.resource] });
    expect(state.render).toHaveBeenCalledExactlyOnceWith(1, expect.anything());
    expect(readImageSource).toHaveBeenCalledOnce();
  });

  it.each([20, 21])("selects and imports at most 20 pages from a %i-page PDF", async (count) => {
    const state = await beginPdfReview(count);
    expect(state.range.value).toBe("1-20");
    expect(state.page.value).toBe("1");
    expect(state.render).toHaveBeenCalledExactlyOnceWith(1, expect.anything());
    changeImportField(state.range, "1-20");
    expect(state.render).toHaveBeenCalledOnce();
    dialogButton("Insert 20 pages").click();
    expect((await state.pending)?.resources).toHaveLength(20);
    expect(state.render.mock.calls.map(([page]) => page)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
  });
});

it("keeps the displayed page synchronized while navigating through an invalid import selection", async () => {
  const state = await beginPdfReview();
  changeImportField(state.range, "1");
  const secondPage = await capacityImageResource(42);
  state.render.mockResolvedValueOnce(secondPage);
  changeImportField(state.range, "0");
  expect(imageImportSubmit().disabled).toBe(true);
  dialogButton("Next page").click();
  await vi.waitFor(() => {
    expect(state.render).toHaveBeenLastCalledWith(2, expect.anything());
    expect(document.querySelector("img")?.getAttribute("src")).toContain(secondPage.data);
  });
  expect(state.page.value).toBe("2");
  expect(imageImportSubmit().disabled).toBe(true);
  changeImportField(state.range, "1");
  expect(state.render).toHaveBeenCalledTimes(2);
  expect(state.page.value).toBe("2");
  expect(document.querySelector("img")?.getAttribute("src")).toContain(secondPage.data);
  expect(dialogButton("Insert 1 page").disabled).toBe(false);
  dialogButton("Insert 1 page").click();
  expect(await state.pending).toEqual({ source: "pdf", resources: [state.resource] });
  expect(state.render.mock.calls.map(([page]) => page)).toEqual([1, 2]);
  expect(readImageSource).toHaveBeenCalledOnce();
});

it("selects a PDF page from the entire thumbnail and preserves independent preview navigation", async () => {
  const state = await beginPdfReview(9);
  const current = document.querySelector<HTMLInputElement>('[aria-label="Include page 1"]')!;
  expect(current.getAttribute("aria-current")).toBe("page");
  changeImportField(state.range, "1");
  expect(current.getAttribute("aria-disabled")).toBe("true");
  const include = document.querySelector<HTMLInputElement>('[aria-label="Include page 3"]')!;
  include.focus();
  const card = include.labels![0]!;
  card.querySelector<HTMLElement>(".inkbook-image-import-thumbnail-image")!.click();
  expect(include.checked).toBe(true);
  expect(document.activeElement).toBe(include);
  expect(state.range.value).toBe("1, 3");
  include.click();
  expect(include.checked).toBe(false);
  expect(state.range.value).toBe("1");
  card.click();
  expect(state.page.value).toBe("1");
  expect(state.render).toHaveBeenCalledOnce();
  const strip = card.closest<HTMLElement>(".inkbook-image-import-thumbnails-strip")!;
  Object.defineProperty(strip, "clientWidth", { value: 400 });
  strip.scrollLeft = 450;
  strip.dispatchEvent(new Event("scroll"));
  expect(document.activeElement).toBe(strip);
  expect(document.querySelector('[aria-label="Include page 9"]')).not.toBeNull();
  expect(state.page.value).toBe("1");
  state.page.focus();
  changeImportField(state.page, "7");
  await reviewedPage(state.render, 7);
  expect(
    document.querySelector('[aria-label="Include page 7"]')?.getAttribute("aria-current"),
  ).toBe("page");
  expect(document.activeElement).toBe(state.page);
  expect(state.range.value).toBe("1, 3");
  imageImportSubmit().click();
  expect((await state.pending)?.resources).toEqual([state.resource, state.resource]);
  expect(state.render.mock.calls.map(([page]) => page)).toEqual([1, 7, 3]);
});

it("places phone raster options before the placement preview and keeps actions outside the scroll body", async () => {
  Platform.isPhone = true;
  Platform.isMobile = true;
  const resource = await validImageResource();
  vi.mocked(prepareRasterImage).mockResolvedValue({ resource });
  const state = setupImageImport();
  try {
    const body = document.querySelector(".inkbook-image-import-body")!;
    const quality = document.querySelector<HTMLSelectElement>("select")!;
    const lock = document.querySelector<HTMLInputElement>(".inkbook-image-import-placement input")!;
    const paper = document.querySelector<HTMLElement>(".inkbook-placement-paper")!;
    const figure = paper.closest("figure")!;
    const insert = dialogButton("Insert");
    expect(figure.hidden).toBe(true);
    expect(insert.disabled).toBe(true);
    selectImportFile();
    await vi.waitFor(() => expect(insert.disabled).toBe(false));
    expect(body.contains(paper)).toBe(true);
    expect(figure.hidden).toBe(false);
    expect(quality.closest<HTMLElement>(".inkbook-image-import-resolution")!.hidden).toBe(false);
    expect(lock.closest("[hidden]")).toBeNull();
    expect(quality.compareDocumentPosition(lock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(lock.compareDocumentPosition(paper) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(body.contains(insert)).toBe(false);
    const cancel = dialogButton("Cancel");
    expect(body.contains(cancel)).toBe(false);
    quality.focus();
    quality.value = "ultra";
    quality.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(insert.disabled).toBe(false));
    expect(document.activeElement).toBe(quality);
    expect(paper.querySelector("img")?.src).toContain(resource.data);
    cancel.click();
    expect(await state.pending).toBeUndefined();
  } finally {
    state.abort.abort();
    Platform.isPhone = false;
    Platform.isMobile = false;
  }
});

it("starts the phone page chooser closed and renders thumbnails only while expanded", async () => {
  Platform.isPhone = true;
  Platform.isMobile = true;
  try {
    const state = await beginPdfReview();
    const trigger = dialogButton("Choose pages");
    const panel = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    const quality = document.querySelector<HTMLSelectElement>("select")!;
    const lock = document.querySelector<HTMLInputElement>(".inkbook-image-import-placement input")!;
    const inOrder = [state.range, quality, lock, trigger, state.page];
    for (const [index, control] of inOrder.slice(1).entries())
      expect(
        inOrder[index]!.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hidden).toBe(true);
    expect(state.renderThumbnail).not.toHaveBeenCalled();
    trigger.click();
    await vi.waitFor(() => expect(panel.querySelectorAll("canvas")).toHaveLength(4));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hidden).toBe(false);
    trigger.click();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hidden).toBe(true);
    expect(panel.querySelector("canvas")).toBeNull();
    state.abort.abort();
    expect(await state.pending).toBeUndefined();
  } finally {
    Platform.isPhone = false;
    Platform.isMobile = false;
  }
});

describe("PDF page input recovery", () => {
  it.each(["0", "", "6"])(
    "rejects preview page %j locally without rendering and recovers in the same field",
    async (value) => {
      const state = await beginPdfReview();
      changeImportField(state.range, "1");
      state.page.focus();
      changeImportField(state.page, value);
      expect(state.page.getAttribute("aria-invalid")).toBe("true");
      const error = fieldAlert(state.page);
      expect(error.hidden).toBe(false);
      expect(error.textContent).toBe(
        new Localization().t("images.failurePreviewPage", { count: 5 }),
      );
      expect(imageImportSubmit().disabled).toBe(true);
      expect(state.render).toHaveBeenCalledOnce();
      changeImportField(state.page, "3");
      await reviewedPage(state.render, 3);
      expect(state.page.hasAttribute("aria-invalid")).toBe(false);
      expect(error.hidden).toBe(true);
      expect(state.range.value).toBe("1");
      expect(document.activeElement).toBe(state.page);
      dialogButton("Cancel").click();
      expect(await state.pending).toBeUndefined();
      expect(state.render.mock.calls.map(([page]) => page)).toEqual([1, 3]);
      expect(readImageSource).toHaveBeenCalledOnce();
    },
  );

  it("blocks an invalid typed range, reports it on change and imports deduplicated recovery pages", async () => {
    const state = await beginPdfReview();
    state.range.value = "0";
    state.range.dispatchEvent(new Event("input", { bubbles: true }));
    expect(imageImportSubmit().disabled).toBe(true);
    expect(state.render).toHaveBeenCalledOnce();
    state.range.dispatchEvent(new Event("change", { bubbles: true }));
    expect(state.range.getAttribute("aria-invalid")).toBe("true");
    const error = fieldAlert(state.range);
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(new Localization().t("images.failurePages"));
    changeImportField(state.range, "3, 3-5, 4");
    await reviewedPage(state.render, 3);
    expect(error.hidden).toBe(true);
    expect(state.range.hasAttribute("aria-invalid")).toBe(false);
    dialogButton("Insert 3 pages").click();
    expect((await state.pending)?.resources).toEqual([
      state.resource,
      state.resource,
      state.resource,
    ]);
    expect(state.render.mock.calls.map(([page]) => page)).toEqual([1, 3, 4, 5]);
    expect(readImageSource).toHaveBeenCalledOnce();
  });
});
