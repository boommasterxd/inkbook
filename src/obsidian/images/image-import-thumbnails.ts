import { Platform, setIcon } from "obsidian";
import { BoundedVersionLru } from "../../domain/cache/bounded-version-lru";
import { IMAGE_LIMITS } from "../../domain/images/image-limits";
import type { Localization } from "../../domain/localization";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import type { MotionPreference } from "../../rendering/motion/transitions";
import type { ObserveMotion } from "../runtime/effective-motion";
import { SettingsPanelMotion } from "../settings/settings-panel-motion";
import { copyPdfThumbnail, PDF_THUMBNAIL_EDGE, type PdfImageSource } from "./pdf-image-source";

const VISIBLE_PAGES = 4;
const RETAINED_PAGES = VISIBLE_PAGES * 2;

interface ThumbnailOptions {
  readonly localization: Localization;
  readonly scheduler: WorkScheduler;
  readonly signal: AbortSignal;
  readonly readMotion: () => MotionPreference;
  readonly observeMotion?: ObserveMotion | undefined;
  readonly displayedRaster: (page: number) => HTMLImageElement | undefined;
  readonly select: (page: number, selected: boolean) => void;
}

interface ThumbnailCard {
  page: number;
  readonly element: HTMLLabelElement;
  readonly image: HTMLElement;
  readonly number: HTMLElement;
  readonly selection: HTMLInputElement;
}

/** Pages the filmstrip independently of the main preview, which can jump to any PDF page. */
export class ImageImportThumbnails {
  readonly #options: ThumbnailOptions;
  readonly #section: HTMLElement;
  readonly #panel: HTMLElement;
  readonly #trigger: HTMLButtonElement | undefined;
  readonly #strip: HTMLElement;
  readonly #track: HTMLElement;
  readonly #visibility: IntersectionObserver | undefined;
  readonly #resize: ResizeObserver | undefined;
  readonly #navigation: HTMLElement;
  readonly #position: HTMLElement;
  readonly #previous: HTMLButtonElement;
  readonly #next: HTMLButtonElement;
  readonly #cache = new BoundedVersionLru<HTMLCanvasElement>(
    RETAINED_PAGES,
    RETAINED_PAGES * PDF_THUMBNAIL_EDGE ** 2 * 4,
    (_key, canvas) => releaseCanvas(canvas),
  );
  readonly #failed = new Set<number>();
  #motion: SettingsPanelMotion | undefined;
  #source: PdfImageSource | undefined;
  #firstPage = 1;
  #lastPage = 0;
  #previewPage = 1;
  #slots = VISIBLE_PAGES;
  #trailingInset = 0;
  #width = 0;
  #selection: readonly number[] | undefined;
  readonly #cards: ThumbnailCard[] = [];
  #active: { readonly controller: AbortController; readonly page: number } | undefined;
  #expanded: boolean;
  #visible = false;
  #busy = false;
  #previewPreparing = false;

  public constructor(parent: HTMLElement, options: ThumbnailOptions) {
    this.#options = options;
    this.#expanded = !Platform.isPhone;
    const { t } = options.localization;
    this.#section = parent.createDiv({ cls: "inkbook-image-import-thumbnails" });
    this.#section.hidden = true;
    if (!this.#expanded) {
      this.#trigger = this.#section.createEl("button", {
        type: "button",
        cls: "inkbook-image-import-thumbnails-disclosure",
        text: t("images.choosePages"),
      });
      this.#trigger.setAttribute("aria-expanded", "false");
      const icon = this.#trigger.createSpan({ attr: { "aria-hidden": "true" } });
      setIcon(icon, "chevron-right");
      this.#listen(this.#trigger, "click", () => this.#toggle());
      for (const event of ["pointerenter", "pointerdown", "focus"])
        this.#listen(this.#trigger, event, () => this.#prepareDisclosure());
    }
    this.#panel = this.#section.createDiv({ cls: "inkbook-image-import-thumbnails-panel" });
    this.#panel.id = `inkbook-pdf-thumbnails-${crypto.randomUUID()}`;
    this.#panel.hidden = !this.#expanded;
    this.#panel.inert = !this.#expanded;
    this.#trigger?.setAttribute("aria-controls", this.#panel.id);
    const header = this.#panel.createDiv({ cls: "inkbook-image-import-thumbnails-header" });
    if (this.#trigger === undefined)
      header.createSpan({
        cls: "inkbook-image-import-thumbnails-title",
        text: t("images.choosePages"),
      });
    this.#navigation = header.createDiv({ cls: "inkbook-image-import-thumbnails-navigation" });
    this.#navigation.hidden = true;
    this.#previous = this.#pager(this.#navigation, "chevron-left", t("images.previousPages"), -1);
    this.#position = this.#navigation.createSpan({ attr: { "aria-live": "polite" } });
    this.#next = this.#pager(this.#navigation, "chevron-right", t("images.nextPages"), 1);
    this.#strip = this.#panel.createDiv({ cls: "inkbook-image-import-thumbnails-strip" });
    this.#strip.setAttribute("role", "group");
    this.#strip.setAttribute("aria-label", t("images.choosePages"));
    this.#strip.dir = "ltr";
    this.#strip.tabIndex = 0;
    this.#track = this.#strip.createDiv({ cls: "inkbook-image-import-thumbnails-track" });
    this.#strip.addEventListener("scroll", () => this.#readScroll(), { signal: options.signal });
    const ownerWindow = parent.ownerDocument.defaultView;
    if (ownerWindow?.ResizeObserver !== undefined) {
      this.#resize = new ownerWindow.ResizeObserver(([entry]) => {
        const width = entry?.contentRect.width ?? 0;
        if (width === 0 || width === this.#width) return;
        this.#width = width;
        this.#scrollTo(this.#firstPage);
      });
    }
    if (ownerWindow?.IntersectionObserver !== undefined) {
      this.#visibility = new ownerWindow.IntersectionObserver((entries) => {
        this.#visible = entries[entries.length - 1]?.isIntersecting ?? false;
        if (this.#visible) this.#fill();
        else this.#active?.controller.abort();
      });
    } else this.#visible = true;
    options.signal.addEventListener("abort", () => this.#dispose(), { once: true });
  }

  public setSource(source: PdfImageSource | undefined): void {
    this.#source = source;
    this.#stopObserving();
    this.#cache.clear();
    this.#clearCards();
    this.#firstPage = 1;
    this.#previewPage = 1;
    const pages = source?.pageCount ?? 1;
    this.#slots = Math.ceil(pages / VISIBLE_PAGES) * VISIBLE_PAGES;
    this.#trailingInset = Platform.isPhone ? (this.#slots - pages) / 2 : 0;
    this.#track.style.inlineSize = `${(this.#slots / VISIBLE_PAGES) * 100}%`;
    if (this.#trigger !== undefined && this.#expanded) this.#toggle();
    this.#section.hidden = source === undefined || source.pageCount < 2;
    this.#navigation.hidden = this.#slots === VISIBLE_PAGES;
    if (this.#expanded && !this.#section.hidden) this.#activateStrip();
  }

  public update(preview: number, selection: readonly number[] | undefined, busy: boolean): void {
    this.#selection = selection;
    this.#busy = busy;
    if (this.#trigger !== undefined) setDisabled(this.#trigger, busy);
    if (busy) this.#active?.controller.abort();
    if (preview !== this.#previewPage) {
      this.#previewPage = preview;
      if (preview < this.#firstPage || preview > this.#lastPage)
        this.#scrollTo(firstPageOfGroup(preview));
    }
    this.#updateControls();
    this.#fill();
  }

  public setPreviewPreparing(preparing: boolean): void {
    this.#previewPreparing = preparing;
    if (preparing) this.#active?.controller.abort();
    else this.#fill();
  }

  #prepareDisclosure(): void {
    this.#motion ??= new SettingsPanelMotion(
      this.#panel,
      this.#options.readMotion,
      this.#options.observeMotion,
    );
  }

  #toggle(): void {
    this.#prepareDisclosure();
    this.#expanded = !this.#expanded;
    this.#trigger?.setAttribute("aria-expanded", String(this.#expanded));
    if (this.#expanded) {
      this.#showPages(this.#firstPage, this.#firstPage + VISIBLE_PAGES - 1);
      this.#motion?.setExpanded(true);
      this.#activateStrip();
    } else {
      this.#stopObserving();
      this.#active?.controller.abort();
      this.#motion?.setExpanded(false, () => this.#clearCards());
    }
  }

  #activateStrip(): void {
    this.#scrollTo(this.#firstPage);
    this.#resize?.observe(this.#strip);
    this.#visibility?.observe(this.#strip);
  }

  #scrollTo(first: number): void {
    if (!this.#expanded) {
      this.#firstPage = first;
      return;
    }
    const width = this.#width || this.#strip.clientWidth;
    this.#strip.scrollLeft = ((first - 1) * width) / VISIBLE_PAGES;
    this.#showPages(first, first + VISIBLE_PAGES - 1);
  }

  #readScroll(): void {
    const width = this.#width || this.#strip.clientWidth;
    if (!this.#expanded || width === 0) return;
    const pageWidth = width / VISIBLE_PAGES;
    const left = this.#strip.scrollLeft;
    // Native scroll positions can be rounded to a device pixel.
    const first = Math.floor((left + 0.5) / pageWidth) + 1;
    const last = Math.ceil((left + width - 0.5) / pageWidth);
    this.#showPages(first, last);
  }

  #clearCards(): void {
    this.#active?.controller.abort();
    for (const card of this.#cards) this.#retireCard(card);
    this.#lastPage = 0;
  }

  #retireCard(card: ThumbnailCard): void {
    if (card.element.hidden) return;
    if (card.selection === this.#strip.ownerDocument.activeElement)
      this.#strip.focus({ preventScroll: true });
    this.#failed.delete(card.page);
    card.element.hidden = true;
    card.image.replaceChildren();
  }

  #showPages(first: number, end: number): void {
    if (!this.#expanded || this.#section.hidden || this.#source === undefined) return;
    const last = Math.min(end, this.#source.pageCount);
    if (first === this.#firstPage && last === this.#lastPage) return;
    this.#firstPage = first;
    this.#lastPage = last;
    if (this.#active !== undefined && (this.#active.page < first || this.#active.page > last))
      this.#active.controller.abort();
    for (const card of this.#cards) {
      if (card.page < first || card.page > last) this.#retireCard(card);
    }
    let following: HTMLElement | null = null;
    for (let page = last; page >= first; page -= 1) {
      const current = this.#cards.find((card) => !card.element.hidden && card.page === page);
      if (current !== undefined) {
        this.#cache.get(String(page), 0);
        following = current.element;
        continue;
      }
      const card = this.#cards.find((card) => card.element.hidden) ?? this.#createCard();
      this.#assignCard(card, page);
      this.#track.insertBefore(card.element, following);
      following = card.element;
    }
    this.#position.textContent = this.#options.localization.t("images.thumbnailRange", {
      start: this.#firstPage,
      end: last,
      total: this.#source.pageCount,
    });
    this.#updateControls();
    this.#fill();
  }

  #updateControls(): void {
    setDisabled(this.#previous, this.#busy || this.#firstPage <= 1);
    setDisabled(
      this.#next,
      this.#busy ||
        firstPageOfGroup(this.#firstPage) + VISIBLE_PAGES > (this.#source?.pageCount ?? 0),
    );
    for (const { element, page, selection } of this.#cards) {
      if (element.hidden) continue;
      if (page === this.#previewPage) selection.setAttribute("aria-current", "page");
      else selection.removeAttribute("aria-current");
      const selected = this.#selection?.includes(page) ?? false;
      if (selection.checked !== selected) selection.checked = selected;
      const count = this.#selection?.length;
      setDisabled(
        selection,
        this.#busy ||
          count === undefined ||
          (selected ? count === 1 : count >= IMAGE_LIMITS.pdfSelectedPages),
      );
    }
  }

  #createCard(): ThumbnailCard {
    const element = this.#track.createEl("label", { cls: "inkbook-image-import-thumbnail" });
    const image = element.createSpan({
      cls: "inkbook-image-import-thumbnail-image",
      attr: { "aria-hidden": "true" },
    });
    const row = element.createSpan({ cls: "inkbook-image-import-thumbnail-selection" });
    const selection = row.createEl("input", { type: "checkbox" });
    const number = row.createSpan({ attr: { "aria-hidden": "true" } });
    const card = { page: 0, element, image, number, selection };
    let pressedPage = 0;
    const { signal } = this.#options;
    element.addEventListener(
      "pointerdown",
      () => {
        pressedPage = card.page;
      },
      { signal },
    );
    element.addEventListener(
      "click",
      (event) => {
        if (
          selection.getAttribute("aria-disabled") === "true" ||
          (event.detail > 0 && pressedPage !== 0 && pressedPage !== card.page)
        )
          event.preventDefault();
      },
      { signal },
    );
    this.#listen(selection, "change", () => this.#options.select(card.page, selection.checked));
    this.#cards.push(card);
    return card;
  }

  #assignCard(card: ThumbnailCard, page: number): void {
    const { t } = this.#options.localization;
    card.element.hidden = false;
    card.page = page;
    const inset = page > this.#slots - VISIBLE_PAGES ? this.#trailingInset : 0;
    card.element.style.marginInlineStart = `${((page - 1 + inset) / this.#slots) * 100}%`;
    card.element.style.inlineSize = `${100 / this.#slots}%`;
    const label = t("images.thumbnailSelect", { page });
    card.selection.setAttribute("aria-label", label);
    card.element.title = label;
    card.number.textContent = String(page);
    const canvas = this.#cache.get(String(page), 0);
    if (canvas !== undefined && canvas.parentElement !== card.image) card.image.append(canvas);
  }

  #pager(parent: HTMLElement, icon: string, label: string, direction: number): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: "clickable-icon inkbook-image-import-page-action",
      type: "button",
      attr: { "aria-label": label, title: label },
    });
    setIcon(button, icon);
    button.querySelector("svg")?.setAttribute("aria-hidden", "true");
    this.#listen(button, "click", () => {
      const group = firstPageOfGroup(this.#firstPage);
      const first =
        direction < 0 && this.#firstPage > group ? group : group + direction * VISIBLE_PAGES;
      this.#scrollTo(first);
    });
    return button;
  }

  #listen(
    element: HTMLButtonElement | HTMLInputElement,
    event: string,
    callback: () => void,
  ): void {
    element.addEventListener(
      event,
      () => {
        if (!this.#busy && element.getAttribute("aria-disabled") !== "true" && !element.disabled)
          callback();
      },
      { signal: this.#options.signal },
    );
  }

  #fill(): void {
    if (
      !this.#expanded ||
      !this.#visible ||
      this.#busy ||
      this.#previewPreparing ||
      this.#active !== undefined ||
      this.#options.signal.aborted
    )
      return;
    const source = this.#source;
    const missing = this.#cards
      .filter(
        (card) =>
          !card.element.hidden &&
          card.image.childElementCount === 0 &&
          !this.#failed.has(card.page),
      )
      .sort((left, right) => left.page - right.page);
    const next = missing.find((card) => card.page === this.#previewPage) ?? missing[0];
    if (source === undefined || next === undefined) return;
    const controller = new AbortController();
    this.#active = { controller, page: next.page };
    void this.#render(source, next, controller.signal).finally(() => {
      this.#active = undefined;
      this.#fill();
    });
  }

  async #render(source: PdfImageSource, card: ThumbnailCard, signal: AbortSignal): Promise<void> {
    const page = card.page;
    try {
      const pending = this.#options.scheduler.checkpoint(signal, "background");
      if (pending !== undefined) await pending;
      signal.throwIfAborted();
      let canvas = await this.#fromPreview(page, signal);
      if (canvas === undefined) {
        signal.throwIfAborted();
        canvas = await source.renderThumbnail(page, {
          document: card.image.ownerDocument,
          signal,
        });
      }
      if (signal.aborted) {
        releaseCanvas(canvas);
        return;
      }
      this.#cache.set(String(page), 0, canvas, canvas.width * canvas.height * 4);
      card.image.append(canvas);
    } catch {
      if (!signal.aborted) this.#failed.add(page);
    }
  }

  async #fromPreview(page: number, signal: AbortSignal): Promise<HTMLCanvasElement | undefined> {
    const image = this.#options.displayedRaster(page);
    if (image === undefined) return undefined;
    const source = image.src;
    if (!image.complete || image.naturalWidth === 0) await decodePreview(image, signal);
    signal.throwIfAborted();
    if (image.src !== source || this.#options.displayedRaster(page) !== image) return undefined;
    return copyPdfThumbnail(image);
  }

  #stopObserving(): void {
    this.#resize?.disconnect();
    this.#width = 0;
    if (this.#visibility === undefined) return;
    this.#visibility.disconnect();
    this.#visibility.takeRecords();
    this.#visible = false;
  }

  #dispose(): void {
    this.#stopObserving();
    this.#clearCards();
    this.#cache.clear();
    this.#motion?.dispose();
    this.#source = undefined;
  }
}

async function decodePreview(image: HTMLImageElement, signal: AbortSignal): Promise<void> {
  if (typeof image.decode !== "function") return;
  let release!: () => void;
  const aborted = new Promise<void>((resolve) => {
    release = resolve;
  });
  signal.addEventListener("abort", release, { once: true });
  try {
    await Promise.race([image.decode().catch(() => undefined), aborted]);
  } finally {
    signal.removeEventListener("abort", release);
  }
}

function firstPageOfGroup(page: number): number {
  return page - ((page - 1) % VISIBLE_PAGES);
}

function setDisabled(button: HTMLButtonElement | HTMLInputElement, disabled: boolean): void {
  const value = String(disabled);
  if (button.getAttribute("aria-disabled") !== value) button.setAttribute("aria-disabled", value);
}

function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
  canvas.remove();
}
