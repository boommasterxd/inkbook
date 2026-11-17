import "./menu-motion";
import type { App } from "obsidian";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { Localization } from "../../../src/domain/localization";
import { TestWorkScheduler } from "../persistence/work-scheduler";
import { validImageResource } from "../persistence/images";
import { PAGE } from "../../unit/domain/store/fixtures";
import { dialogButton, installDialogTestLifecycle } from "./dialog";
import type {
  ImageImportRequest,
  ImportedImageBatch,
} from "../../../src/obsidian/embeds/active-scene/editor-chrome-openings";

vi.mock("../../../src/obsidian/images/image-import", async (load) => ({
  ...(await load<object>()),
  readImageSource: vi.fn(),
  prepareRasterImage: vi.fn(),
}));
vi.mock("../../../src/obsidian/images/pdf-image-source", async (load) => ({
  ...(await load<object>()),
  openPdfImageSource: vi.fn(),
}));

import { openImageImportDialog } from "../../../src/obsidian/images/image-import-dialog";
import { prepareRasterImage, readImageSource } from "../../../src/obsidian/images/image-import";
import {
  openPdfImageSource,
  type PdfImageSource,
} from "../../../src/obsidian/images/pdf-image-source";

export const imageImportMocks = { prepareRasterImage, readImageSource, openPdfImageSource };

const observedThumbnails = new Map<Element, (visible: boolean) => void>();
let thumbnailsVisible = true;

export function setImportThumbnailVisibility(visible: boolean): void {
  thumbnailsVisible = visible;
  for (const notify of observedThumbnails.values()) notify(visible);
}

class ImageImportIntersectionObserver {
  #target: Element | undefined;

  public constructor(private readonly notify: (entries: { isIntersecting: boolean }[]) => void) {}

  public observe(target: Element): void {
    this.#target = target;
    const publish = (isIntersecting: boolean): void => this.notify([{ isIntersecting }]);
    observedThumbnails.set(target, publish);
    publish(thumbnailsVisible);
  }

  public disconnect(): void {
    if (this.#target !== undefined) observedThumbnails.delete(this.#target);
  }

  public takeRecords(): readonly unknown[] {
    return [];
  }
}

export function installImageImportTestLifecycle(): void {
  installDialogTestLifecycle();
  beforeEach(() => {
    thumbnailsVisible = true;
    vi.stubGlobal("IntersectionObserver", ImageImportIntersectionObserver);
    vi.mocked(readImageSource)
      .mockReset()
      .mockResolvedValue(new Uint8Array([1]));
    vi.mocked(prepareRasterImage).mockReset();
    vi.mocked(openPdfImageSource).mockReset();
  });
  afterEach(() => {
    observedThumbnails.clear();
    vi.unstubAllGlobals();
  });
}

export function setupImageImport(complete: ImageImportRequest["submit"] = async () => "committed") {
  const abort = new AbortController();
  let imported: ImportedImageBatch | undefined;
  const submit = vi.fn<ImageImportRequest["submit"]>(async (batch, signal) => {
    const status = await complete(batch, signal);
    if (status === "committed" && !signal.aborted) imported = batch;
    return status;
  });
  const pending = openImageImportDialog({
    app: { workspace: { containerEl: document.body } } as App,
    localization: new Localization(),
    scheduler: new TestWorkScheduler(),
    readMotion: () => "reduced",
    signal: abort.signal,
    page: PAGE,
    centerX: PAGE.margin + PAGE.innerWidth / 2,
    submit,
  }).then(() => imported);
  return { pending, abort, submit };
}

/** Opens a fresh PDF review using one valid raster and an independently owned source. */
export async function setupPdfImport(pageCount = 5, submit?: ImageImportRequest["submit"]) {
  const resource = await validImageResource();
  const render = vi.fn(async (_page: number) => resource);
  const renderThumbnail = vi.fn(renderImportThumbnail);
  const dispose = vi.fn(async () => undefined);
  vi.mocked(readImageSource).mockResolvedValue(new TextEncoder().encode("%PDF-1.7"));
  vi.mocked(openPdfImageSource).mockResolvedValue({ pageCount, render, renderThumbnail, dispose });
  return { ...setupImageImport(submit), resource, render, renderThumbnail, dispose };
}

export const renderImportThumbnail: PdfImageSource["renderThumbnail"] = async (_page, options) => {
  const canvas = options.document.createElement("canvas");
  canvas.width = 104;
  canvas.height = 144;
  return canvas;
};

export function selectImportFile(name = "source.png"): void {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File(["image"], name)],
  });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Uses the visible action name for both raster and page-count PDF variants. */
export function imageImportSubmit(): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((candidate) =>
    /^Insert(?: \d+ pages?| pages)?$/.test(
      candidate.getAttribute("aria-label") ?? candidate.textContent ?? "",
    ),
  );
  if (button === undefined) throw new Error("Missing image import submission action.");
  return button;
}

export function changeImportField(field: HTMLInputElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

export async function beginImageReview() {
  const state = setupImageImport();
  selectImportFile();
  await vi.waitFor(() => expect(dialogButton("Insert").disabled).toBe(false));
  return { ...state, warning: document.querySelector<HTMLElement>('[role="status"]')! };
}

export async function beginPdfBatch(
  render: PdfImageSource["render"],
  dispose: PdfImageSource["dispose"] = vi.fn(async () => undefined),
) {
  vi.mocked(readImageSource).mockResolvedValue(new TextEncoder().encode("%PDF-1.7"));
  vi.mocked(openPdfImageSource).mockResolvedValue({
    pageCount: 20,
    render,
    renderThumbnail: vi.fn(renderImportThumbnail),
    dispose,
  });
  const state = setupImageImport();
  selectImportFile();
  await vi.waitFor(() => expect(imageImportSubmit().disabled).toBe(false));
  changeImportField(document.querySelector<HTMLInputElement>('input[type="text"]')!, "1-20");
  imageImportSubmit().click();
  return state;
}
