import "./menu-motion";
import type { App } from "obsidian";
import { beforeEach, expect, vi } from "vitest";
import { Localization } from "../../../src/domain/localization";
import { TestWorkScheduler } from "../persistence/work-scheduler";
import { validImageResource } from "../persistence/images";
import { dialogButton, installDialogTestLifecycle } from "./dialog";

vi.mock("../../../src/obsidian/images/image-import", async (load) => ({
  ...(await load<object>()),
  readImageSource: vi.fn(),
  prepareRasterImage: vi.fn(),
}));
vi.mock("../../../src/obsidian/images/pdf-image-source", () => ({ openPdfImageSource: vi.fn() }));

import { openImageImportDialog } from "../../../src/obsidian/images/image-import-dialog";
import { prepareRasterImage, readImageSource } from "../../../src/obsidian/images/image-import";
import {
  openPdfImageSource,
  type PdfImageSource,
} from "../../../src/obsidian/images/pdf-image-source";

export const imageImportMocks = { prepareRasterImage, readImageSource, openPdfImageSource };

export function installImageImportTestLifecycle(): void {
  installDialogTestLifecycle();
  beforeEach(() => {
    vi.mocked(readImageSource)
      .mockReset()
      .mockResolvedValue(new Uint8Array([1]));
    vi.mocked(prepareRasterImage).mockReset();
    vi.mocked(openPdfImageSource).mockReset();
  });
}

export function setupImageImport() {
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

/** Opens a fresh PDF review using one valid raster and an independently owned source. */
export async function setupPdfImport(pageCount = 5) {
  const resource = await validImageResource();
  const render = vi.fn(async (_page: number) => resource);
  const dispose = vi.fn(async () => undefined);
  vi.mocked(readImageSource).mockResolvedValue(new TextEncoder().encode("%PDF-1.7"));
  vi.mocked(openPdfImageSource).mockResolvedValue({ pageCount, render, dispose });
  return { ...setupImageImport(), resource, render, dispose };
}

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
  vi.mocked(openPdfImageSource).mockResolvedValue({ pageCount: 20, render, dispose });
  const state = setupImageImport();
  selectImportFile();
  await vi.waitFor(() => expect(imageImportSubmit().disabled).toBe(false));
  changeImportField(document.querySelector<HTMLInputElement>('input[type="text"]')!, "1-20");
  imageImportSubmit().click();
  return state;
}
