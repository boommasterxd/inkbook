import {
  applyColorScheme,
  type ColorSchemeBroadcaster,
  type InkbookColorScheme,
} from "../theme/color-scheme";
import { registerFocusNavigation } from "../runtime/focus-navigation";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import {
  PresentationScrollLifecycle,
  resolveScrollOwner,
  ScrollbarLeaseRegistry,
} from "../scrolling";
import type {
  PresentationAttachment,
  PresentationAttachmentInput,
  PresentationRemovalRange,
  PresentationRemovalSpacing,
  PresentationSessionPort,
} from "./presentation-port";
import type { InkbookLockedPreviewDescriptor } from "./locked-preview";
import type { PreviewContentIdentity } from "./safe-preview-svg";
import { PresentationExit } from "./presentation-exit";
import { PresentationEntrance, type PresentationEntranceState } from "./presentation-entrance";
import {
  LAYOUT_TRANSITION_CLASS,
  PresentationScrollRangeReserve,
} from "./transition-scroll-stability";

const LEASES_BY_DOCUMENT = new WeakMap<Document, ScrollbarLeaseRegistry<HTMLElement>>();

interface PresentationMeasurement {
  readonly availableWidth: number;
  readonly contentWidth: number;
  readonly requiresSettledRead: boolean;
}

export interface PresentationPreviewLifecycle {
  readonly contentIdentity?: PreviewContentIdentity;
  readonly element: HTMLElement;
  readonly entranceState?: PresentationEntranceState;
  readonly refresh?: () => void;
  readonly ensureReady?: () => Promise<void>;
  readonly setBackgroundWait?: (wait: (() => Promise<void>) | undefined) => void;
  readonly dispose?: () => void;
  readonly requestHostMeasure?: () => void;
  readonly removeMarkdown?: (
    range: PresentationRemovalRange,
    expectedSource: string,
    mutate: () => void,
  ) => boolean;
  readonly measureRemovalSpacing?: (range: PresentationRemovalRange) => PresentationRemovalSpacing;
  readonly setDescriptor?: (descriptor: InkbookLockedPreviewDescriptor) => void;
  readonly setAspectRatio?: (aspectRatio: number) => void;
  readonly setSource?: (source: string) => Promise<PreviewContentIdentity | undefined>;
}

type MutablePresentationAttachment = Omit<PresentationAttachment, "previewContentIdentity"> & {
  previewContentIdentity?: PreviewContentIdentity;
};

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
  readonly #attachment: MutablePresentationAttachment;
  readonly #sessions: PresentationSessionPort;
  readonly #exit: PresentationExit;
  readonly #entrance: PresentationEntrance | undefined;
  #disposeScheme: (() => void) | undefined;
  #disposeFocusNavigation: (() => void) | undefined;
  #frame: number | undefined;
  #activationPending = false;
  #appliedScheme: InkbookColorScheme | undefined;
  #measured = false;
  #measurementFrame: number | undefined;
  #mounted = false;
  #observer: ResizeObserver | undefined;
  #hostMeasureDeferred = false;
  readonly #owningWindow: Window;
  readonly #workScheduler: WorkScheduler;
  readonly #previewLifecycle: PresentationPreviewLifecycle | undefined;
  readonly #scroll: PresentationScrollLifecycle<HTMLElement, PresentationMeasurement>;
  readonly #scrollRangeReserve: PresentationScrollRangeReserve;
  readonly #transitionObserver: MutationObserver | undefined;

  constructor(
    attachment: PresentationAttachmentInput,
    sessions: PresentationSessionPort,
    scheme: ColorSchemeBroadcaster,
    previewLifecycle: PresentationPreviewLifecycle | undefined,
    workScheduler: WorkScheduler,
  ) {
    this.#sessions = sessions;
    const ownerDocument = attachment.root.ownerDocument;
    const owningWindow = ownerDocument.defaultView;
    if (owningWindow === null) throw new Error("The Inkbook presentation has no owning window.");
    this.#owningWindow = owningWindow;
    this.#workScheduler = workScheduler;
    this.#previewLifecycle = previewLifecycle;
    this.#exit = new PresentationExit(
      attachment.root,
      owningWindow,
      this.#workScheduler,
      () => this.#sessions.getMotionPreference?.() ?? "system",
      previewLifecycle?.measureRemovalSpacing,
      previewLifecycle?.removeMarkdown,
    );
    this.#entrance = this.#createEntrance(attachment.root, previewLifecycle);
    let lifecycle: PresentationScrollLifecycle<HTMLElement, PresentationMeasurement> | undefined;
    this.#scrollRangeReserve = new PresentationScrollRangeReserve(() => lifecycle?.owner ?? null);
    const resolvedAttachment: MutablePresentationAttachment = {
      ...attachment,
      ...this.#initialPresentationOptions(previewLifecycle),
      ...(previewLifecycle?.contentIdentity === undefined
        ? {}
        : { previewContentIdentity: previewLifecycle.contentIdentity }),
      ...(previewLifecycle === undefined
        ? {}
        : {
            preview: previewLifecycle.element,
            ...(previewLifecycle.setAspectRatio === undefined
              ? {}
              : { setPreviewAspectRatio: previewLifecycle.setAspectRatio }),
            ...(previewLifecycle.setSource === undefined
              ? {}
              : {
                  setPreviewSource: async (source: string) => {
                    const identity = await previewLifecycle.setSource?.(source);
                    if (identity !== undefined) {
                      resolvedAttachment.previewContentIdentity = identity;
                    }
                  },
                }),
          }),
      removal: this.#exit,
      scrollRangeReserve: this.#scrollRangeReserve,
      scrollOwner: () => lifecycle?.owner ?? null,
    };
    this.#attachment = resolvedAttachment;
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
        cancel: (handle) => this.#workScheduler.cancelFrame(handle),
        request: (callback) => this.#workScheduler.requestFrame(callback),
      },
    });
    this.#disposeScheme = scheme.subscribe((nextScheme) => {
      const previousScheme = this.#appliedScheme;
      if (previousScheme === nextScheme) return;
      this.#appliedScheme = nextScheme;
      applyColorScheme(attachment.root, nextScheme);
      if (previousScheme !== undefined) this.#previewLifecycle?.refresh?.();
    });
    this.#transitionObserver = this.#createTransitionObserver(attachment.root, owningWindow);
  }

  #createTransitionObserver(
    root: HTMLElement,
    owningWindow: Window & { readonly MutationObserver?: typeof MutationObserver },
  ): MutationObserver | undefined {
    const constructor = owningWindow.MutationObserver;
    if (constructor === undefined) return undefined;
    const observer = new constructor(() => this.#flushDeferredHostMeasure());
    observer.observe(root, {
      attributeFilter: ["class"],
      attributes: true,
    });
    return observer;
  }

  #initialPresentationOptions(preview: PresentationPreviewLifecycle | undefined) {
    const loadingStartedAt = preview?.entranceState?.loadingStartedAt;
    if (preview?.entranceState !== undefined) delete preview.entranceState.loadingStartedAt;
    return {
      ...(preview?.ensureReady === undefined ? {} : { ensurePreviewReady: preview.ensureReady }),
      ...(preview?.setBackgroundWait === undefined
        ? {}
        : { setPreviewBackgroundWait: preview.setBackgroundWait }),
      ...(preview?.refresh === undefined ? {} : { refreshPreview: preview.refresh }),
      ...(loadingStartedAt === undefined ? {} : { loadingStartedAt }),
      ...(this.#entrance === undefined
        ? {}
        : { whenPresented: this.#entrance.ready, initialEntrance: this.#entrance }),
    };
  }

  #createEntrance(root: HTMLElement, preview: PresentationPreviewLifecycle | undefined) {
    root.dataset.inkbookMotion = this.#sessions.getMotionPreference?.() ?? "system";
    if (preview === undefined) return undefined;
    return new PresentationEntrance({
      workScheduler: this.#workScheduler,
      root,
      preview: preview.element,
      ownerWindow: this.#owningWindow,
      motion: () => this.#sessions.getMotionPreference?.() ?? "system",
      onPresented: () => this.#activateWhenReady(),
      ...(preview.entranceState === undefined ? {} : { state: preview.entranceState }),
    });
  }

  mount(): void {
    if (this.#mounted) {
      return;
    }
    this.#mounted = true;
    this.#disposeFocusNavigation = registerFocusNavigation(this.#attachment.root);
    this.#entrance?.prepare();
    this.#owningWindow.addEventListener("resize", this.#handleOwningWindowResize, {
      passive: true,
    });
    this.#sessions.mount(this.#attachment);
    const owningWindow = this.#attachment.root.ownerDocument.defaultView;
    if (owningWindow === null) return;
    this.#frame = this.#workScheduler.requestFrame(() => {
      this.#frame = undefined;
      if (!this.#mounted || !this.#scroll.mount()) return;
      this.#observer = new owningWindow.ResizeObserver(() => {
        this.#requestHostMeasure();
        this.#scroll.transferAfterLayoutChange();
        this.#scheduleSettledMeasurement();
      });
      this.#observer.observe(this.#attachment.root);
    });
  }

  activate(): void {
    if (!this.#mounted) return;
    if (!this.#measured || this.#entrance?.pending === true) {
      this.#activationPending = true;
      return;
    }
    this.#sessions.activate(this.#attachment);
  }

  updatePreview(descriptor: InkbookLockedPreviewDescriptor): void {
    this.#previewLifecycle?.setDescriptor?.(descriptor);
    this.#attachment.previewContentIdentity = descriptor.contentIdentity;
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
    this.#attachment.root.style.setProperty(
      "--inkbook-shell-radius",
      `${String(shellRadius(measurement.contentWidth))}px`,
    );
    if (measurement.requiresSettledRead) {
      this.#measured = false;
      this.#scheduleSettledMeasurement();
      return;
    }
    if (measurement.contentWidth <= 0) return;
    this.#measured = true;
    this.#entrance?.measure();
    this.#activateWhenReady();
  }

  #activateWhenReady(): void {
    if (this.#mounted && this.#measured && !this.#entrance?.pending && this.#activationPending) {
      this.#activationPending = false;
      this.#sessions.activate(this.#attachment);
    }
  }

  #scheduleSettledMeasurement(): void {
    if (!this.#mounted || this.#measurementFrame !== undefined) return;
    this.#measurementFrame = this.#workScheduler.requestFrame(() => {
      this.#measurementFrame = undefined;
      const owner = this.#scroll.owner;
      if (owner === null || !this.#mounted) return;
      this.#applyMeasurement(
        readPresentationMeasurement(this.#attachment.root, owner, this.#owningWindow),
      );
    });
  }

  readonly #handleOwningWindowResize = (): void => {
    if (!this.#mounted) return;
    this.#requestHostMeasure();
    this.#scroll.transferAfterLayoutChange();
    this.#scheduleSettledMeasurement();
  };

  #requestHostMeasure(): void {
    if (
      this.#transitionObserver !== undefined &&
      this.#attachment.root.classList.contains(LAYOUT_TRANSITION_CLASS)
    ) {
      this.#hostMeasureDeferred = true;
      return;
    }
    this.#previewLifecycle?.requestHostMeasure?.();
  }

  #flushDeferredHostMeasure(): void {
    if (
      !this.#hostMeasureDeferred ||
      this.#attachment.root.classList.contains(LAYOUT_TRANSITION_CLASS)
    ) {
      return;
    }
    this.#hostMeasureDeferred = false;
    this.#previewLifecycle?.requestHostMeasure?.();
  }

  dispose(): void {
    this.#previewLifecycle?.dispose?.();
    this.#disposeFocusNavigation?.();
    this.#disposeFocusNavigation = undefined;
    this.#entrance?.dispose();
    this.#exit.dispose();
    this.#disposeScheme?.();
    this.#disposeScheme = undefined;
    if (this.#mounted) {
      this.#mounted = false;
      this.#owningWindow.removeEventListener("resize", this.#handleOwningWindowResize);
      this.#activationPending = false;
      this.#measured = false;
      const owningWindow = this.#attachment.root.ownerDocument.defaultView;
      if (this.#frame !== undefined && owningWindow !== null) {
        this.#workScheduler.cancelFrame(this.#frame);
      }
      if (this.#measurementFrame !== undefined && owningWindow !== null) {
        this.#workScheduler.cancelFrame(this.#measurementFrame);
      }
      this.#frame = undefined;
      this.#measurementFrame = undefined;
      this.#observer?.disconnect();
      this.#observer = undefined;
      this.#hostMeasureDeferred = false;
      this.#scrollRangeReserve.dispose();
      this.#scroll.unload();
      this.#sessions.detach(this.#attachment);
    }
    this.#transitionObserver?.disconnect();
  }
}

function shellRadius(contentWidth: number): number {
  return Math.min(20, Math.max(10, contentWidth * 0.02));
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
