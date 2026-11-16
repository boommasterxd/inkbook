// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { Localization } from "../../../../src/domain/localization";
import { dialogButton } from "../../../fixtures/obsidian/dialog";
import { capacityImageResource } from "../../../fixtures/persistence/images";
import {
  changeImportField,
  imageImportSubmit,
  imageImportMocks,
  installImageImportTestLifecycle,
  selectImportFile,
  setupPdfImport,
} from "../../../fixtures/obsidian/image-import-dialog";

const { readImageSource, openPdfImageSource } = imageImportMocks;
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

function unselectedNotice(): HTMLElement {
  return [...document.querySelectorAll("div")].find(
    (element) => element.textContent === "Not selected for import",
  )!;
}

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
    expect(unselectedNotice().hidden).toBe(true);
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
    expect(unselectedNotice().hidden).toBe(false);
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
    expect(unselectedNotice().hidden).toBe(true);
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
  expect(unselectedNotice().hidden).toBe(false);
  expect(dialogButton("Insert 1 page").disabled).toBe(false);
  dialogButton("Insert 1 page").click();
  expect(await state.pending).toEqual({ source: "pdf", resources: [state.resource] });
  expect(state.render.mock.calls.map(([page]) => page)).toEqual([1, 2]);
  expect(readImageSource).toHaveBeenCalledOnce();
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
      expect(unselectedNotice().hidden).toBe(false);
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
