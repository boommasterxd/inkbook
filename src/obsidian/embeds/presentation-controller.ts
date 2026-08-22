import {
  applyColorScheme,
  type ColorSchemeBroadcaster,
  type InkbookColorScheme,
} from "../theme/color-scheme";
import {
  PresentationScrollLifecycle,
  resolveScrollOwner,
  ScrollbarLeaseRegistry,
} from "../scrolling";
import type {
  LockedPreviewSchemeCapability,
  LockedPreviewSchemeCapabilityCheck,
} from "./locked-preview-scheme-capability";
import type {
  PresentationAttachment,
  PresentationAttachmentInput,
  PresentationSessionPort,
} from "./presentation-port";

const LEASES_BY_DOCUMENT = new WeakMap<Document, ScrollbarLeaseRegistry<HTMLElement>>();

interface PresentationMeasurement {
  readonly availableWidth: number;
  readonly contentWidth: number;
  readonly requiresSettledRead: boolean;
}

export interface PresentationPreviewLifecycle {
  readonly capability?: LockedPreviewSchemeCapability;
  readonly image: HTMLImageElement;
  readonly onImageReplaced?: (image: HTMLImageElement) => void;
}

function leasesFor(document: Document): ScrollbarLeaseRegistry<HTMLElement> {
  const current = LEASES_BY_DOCUMENT.get(document);
  if (current !== undefined) return current;
  const leases = new ScrollbarLeaseRegistry<HTMLElement>({
    add: (element, className) => element.classList.add(className),
    remove: (element, className) => element.classList.remove(className),
  });
  LEASES_BY_DOCUMENT.set(document, leases);
  return leases;
}

export class PresentationController {
  readonly #attachment: PresentationAttachment;
  readonly #sessions: PresentationSessionPort;
  #disposeScheme: (() => void) | undefined;
  #frame: number | undefined;
  #activationPending = false;
  #appliedScheme: InkbookColorScheme | undefined;
  readonly #capability: LockedPreviewSchemeCapabilityCheck | undefined;
  #measured = false;
  #measurementFrame: number | undefined;
  #mounted = false;
  #observer: ResizeObserver | undefined;
  readonly #owningWindow: Window;
  #previewImage: HTMLImageElement | undefined;
  readonly #previewLifecycle: PresentationPreviewLifecycle | undefined;
  #schemeGeneration = 0;
  readonly #scroll: PresentationScrollLifecycle<HTMLElement, PresentationMeasurement>;

  constructor(
    attachment: PresentationAttachmentInput,
    sessions: PresentationSessionPort,
    scheme: ColorSchemeBroadcaster,
    previewLifecycle?: PresentationPreviewLifecycle,
  ) {
    this.#sessions = sessions;
    const ownerDocument = attachment.root.ownerDocument;
    const owningWindow = ownerDocument.defaultView;
    if (owningWindow === null) throw new Error("The Inkbook presentation has no owning window.");
    this.#owningWindow = owningWindow;
    this.#previewLifecycle = previewLifecycle;
    this.#previewImage = previewLifecycle?.image;
    this.#capability = previewLifecycle?.capability?.supportsContextRepaint(owningWindow);
    let lifecycle: PresentationScrollLifecycle<HTMLElement, PresentationMeasurement> | undefined;
    this.#attachment = {
      ...attachment,
      scrollOwner: () => lifecycle?.owner ?? null,
    };
    this.#scroll = lifecycle = new PresentationScrollLifecycle<
      HTMLElement,
      PresentationMeasurement
    >({
      leases: leasesFor(ownerDocument),
      measurement: {
        apply: (measurement) => this.#applyMeasurement(measurement),
        read: (owner) => readPresentationMeasurement(attachment.root, owner, owningWindow),
      },
      resolveOwner: () =>
        resolveScrollOwner(
          attachment.root,
          {
            getOverflowY: (element) => owningWindow.getComputedStyle(element).overflowY,
            getParent: (element) => element.parentElement,
            scrollingElement: ownerDocument.scrollingElement as HTMLElement | null,
          },
          {
            getClientHeight: (element) => element.clientHeight,
            getScrollHeight: (element) => element.scrollHeight,
            getScrollTop: (element) => element.scrollTop,
            setScrollTop: (element, scrollTop) => {
              element.scrollTop = scrollTop;
            },
          },
        ),
      scheduler: {
        cancel: (handle) => owningWindow.cancelAnimationFrame(handle),
        request: (callback) => owningWindow.requestAnimationFrame(callback),
      },
    });
    this.#disposeScheme = scheme.subscribe((nextScheme) => {
      const previousScheme = this.#appliedScheme;
      if (previousScheme === nextScheme) return;
      this.#appliedScheme = nextScheme;
      applyColorScheme(attachment.root, nextScheme);
      if (previousScheme !== undefined) this.#schedulePreviewReplacement();
    });
  }

  public get lockedPreviewImage(): HTMLImageElement | undefined {
    return this.#previewImage;
  }

  mount(): void {
    if (this.#mounted) {
      return;
    }
    this.#mounted = true;
    this.#sessions.mount(this.#attachment);
    const owningWindow = this.#attachment.root.ownerDocument.defaultView;
    if (owningWindow === null) return;
    this.#frame = owningWindow.requestAnimationFrame(() => {
      this.#frame = undefined;
      if (!this.#mounted || !this.#scroll.mount()) return;
      this.#observer = new owningWindow.ResizeObserver(() => {
        this.#scroll.transferAfterLayoutChange();
        this.#scheduleSettledMeasurement();
      });
      this.#observer.observe(this.#attachment.root);
    });
  }

  activate(): void {
    if (!this.#mounted) return;
    if (!this.#measured) {
      this.#activationPending = true;
      return;
    }
    this.#sessions.activate(this.#attachment);
  }

  public get scrollOwner(): HTMLElement | null {
    return this.#scroll.owner;
  }

  #applyMeasurement(measurement: PresentationMeasurement): void {
    this.#attachment.root.style.setProperty(
      "--inkbook-owner-inline-limit",
      `${String(measurement.availableWidth)}px`,
    );
    this.#attachment.root.style.setProperty(
      "--inkbook-container-width",
      `${String(measurement.contentWidth)}px`,
    );
    if (measurement.requiresSettledRead) {
      this.#measured = false;
      this.#scheduleSettledMeasurement();
      return;
    }
    if (measurement.contentWidth <= 0) return;
    this.#measured = true;
    if (this.#activationPending) {
      this.#activationPending = false;
      this.#sessions.activate(this.#attachment);
    }
  }

  #scheduleSettledMeasurement(): void {
    if (!this.#mounted || this.#measurementFrame !== undefined) return;
    this.#measurementFrame = this.#owningWindow.requestAnimationFrame(() => {
      this.#measurementFrame = undefined;
      const owner = this.#scroll.owner;
      if (owner === null || !this.#mounted) return;
      this.#applyMeasurement(
        readPresentationMeasurement(this.#attachment.root, owner, this.#owningWindow),
      );
    });
  }

  #schedulePreviewReplacement(): void {
    const capability = this.#capability;
    if (capability === undefined) return;
    const generation = ++this.#schemeGeneration;
    void capability.result.then((supported) => {
      if (
        supported ||
        generation !== this.#schemeGeneration ||
        !this.#mounted ||
        this.#attachment.root.dataset.inkbookState !== "locked"
      )
        return;
      const image = this.#previewImage;
      if (image === undefined || !this.#attachment.root.contains(image)) return;
      const replacement = image.cloneNode(false) as HTMLImageElement;
      image.replaceWith(replacement);
      this.#previewImage = replacement;
      this.#previewLifecycle?.onImageReplaced?.(replacement);
    });
  }

  dispose(): void {
    this.#disposeScheme?.();
    this.#disposeScheme = undefined;
    this.#capability?.dispose();
    if (this.#mounted) {
      this.#mounted = false;
      this.#schemeGeneration += 1;
      this.#activationPending = false;
      this.#measured = false;
      const owningWindow = this.#attachment.root.ownerDocument.defaultView;
      if (this.#frame !== undefined && owningWindow !== null) {
        owningWindow.cancelAnimationFrame(this.#frame);
      }
      if (this.#measurementFrame !== undefined && owningWindow !== null) {
        owningWindow.cancelAnimationFrame(this.#measurementFrame);
      }
      this.#frame = undefined;
      this.#measurementFrame = undefined;
      this.#observer?.disconnect();
      this.#observer = undefined;
      this.#scroll.unload();
      this.#sessions.detach(this.#attachment);
    }
  }
}

function readPresentationMeasurement(
  root: HTMLElement,
  owner: HTMLElement,
  owningWindow: Window,
): PresentationMeasurement {
  const rootRect = root.getBoundingClientRect();
  const ownerRect = owner.getBoundingClientRect();
  const rootLeft = finiteLayoutValue(rootRect.left);
  const ownerClientRight = finiteLayoutValue(ownerRect.left) + owner.clientLeft + owner.clientWidth;
  const availableWidth = Math.max(0, ownerClientRight - rootLeft);
  const requiresSettledRead = rootRect.width > availableWidth + 0.5;
  const backgroundCandidate = root.getElementsByClassName("inkbook-background-container").item(0);
  const background = isHtmlElement(backgroundCandidate) ? backgroundCandidate : null;
  const measuredElement = background ?? root;
  const contentWidth = Math.max(
    0,
    Math.min(readContentBoxWidth(measuredElement, owningWindow), availableWidth),
  );
  return { availableWidth, contentWidth, requiresSettledRead };
}

function readContentBoxWidth(element: HTMLElement, owningWindow: Window): number {
  const width = element.getBoundingClientRect().width;
  const style = owningWindow.getComputedStyle(element);
  return (
    width -
    cssPixels(style.borderLeftWidth) -
    cssPixels(style.borderRightWidth) -
    cssPixels(style.paddingLeft) -
    cssPixels(style.paddingRight)
  );
}

function cssPixels(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

function finiteLayoutValue(value: number | undefined): number {
  return Number.isFinite(value) ? (value ?? 0) : 0;
}

function isHtmlElement(element: Element | null): element is HTMLElement {
  return element !== null && "style" in element;
}
