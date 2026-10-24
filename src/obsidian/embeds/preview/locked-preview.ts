import { Platform } from "obsidian";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { createPreviewSvgAsync } from "./safe-preview-builder";
import { PreviewIdleScheduler } from "./preview-idle-scheduler";
import type { InkbookDocumentRecognitionPort } from "./document-recognition";
import type { InkbookColorScheme } from "../../theme/color-scheme";
import { StaticPreviewSurface } from "../../../rendering/scene";

import {
  loadValidatedPreviewSvg,
  samePreviewContentIdentity,
  type PreviewContentIdentity,
} from "./safe-preview-svg";

export interface InkbookLockedPreviewDescriptor {
  readonly aspectRatio: number;
  readonly contentIdentity: PreviewContentIdentity;
  readonly safeSvg: string;
}

/** Presentation callbacks shared by attached previews and their active scene. */
export interface LockedPreviewPresentation {
  readonly releasePreview?: () => void;
  readonly setPreviewAspectRatio?: (aspectRatio: number) => void;
  readonly refreshPreview?: () => void;
  readonly ensurePreviewReady?: () => Promise<void>;
  readonly setPreviewBackgroundWait?: (wait: (() => Promise<void> | undefined) | undefined) => void;
  readonly setPreviewSource?: (source: string) => Promise<void>;
}

export interface InkbookLockedPreviewSurface {
  readonly releaseHiddenSurface: () => void;
  readonly element: HTMLButtonElement;
  readonly refresh: () => void;
  readonly ensureReady: () => Promise<void>;
  readonly setBackgroundWait: (wait: (() => Promise<void> | undefined) | undefined) => void;
  readonly dispose: () => void;
  readonly setDescriptor: (descriptor: InkbookLockedPreviewDescriptor) => void;
  readonly setColorScheme: (scheme: InkbookColorScheme) => void;
  readonly setAspectRatio: (aspectRatio: number) => void;
  readonly setSource: (source: string) => Promise<PreviewContentIdentity | undefined>;
}

export function createInkbookLockedPreview(
  button: HTMLButtonElement,
  descriptor: InkbookLockedPreviewDescriptor,
  workScheduler: WorkScheduler,
  sourceLoader?: {
    readonly documentId: string;
    readonly documents: InkbookDocumentRecognitionPort;
  },
): InkbookLockedPreviewSurface {
  return new LockedPreview(button, descriptor, workScheduler, sourceLoader);
}

class LockedPreview implements InkbookLockedPreviewSurface {
  readonly #media: HTMLDivElement;
  #surface: StaticPreviewSurface | undefined;
  readonly #scheduler: PreviewIdleScheduler;
  #descriptor: InkbookLockedPreviewDescriptor;
  #mountedIdentity: PreviewContentIdentity | undefined;
  #sourceGeneration = 0;
  #sourceAbort: AbortController | undefined;
  #sourcePending: Promise<PreviewContentIdentity | undefined> | undefined;
  #generation = 0;
  #disposed = false;
  #prepared: SVGSVGElement | undefined;
  #pending: Promise<void> | undefined;
  #preparationAbort: AbortController | undefined;
  #readinessRequests = 0;
  #failure: Error | undefined;
  #releaseRequested = false;

  public constructor(
    public readonly element: HTMLButtonElement,
    descriptor: InkbookLockedPreviewDescriptor,
    private readonly workScheduler: WorkScheduler,
    private readonly sourceLoader?: {
      readonly documentId: string;
      readonly documents: InkbookDocumentRecognitionPort;
    },
  ) {
    if (Platform.isAndroidApp) element.classList.add("inkbook-locked-preview-android");
    this.#media = element.createDiv({ cls: "inkbook-locked-preview-media" });
    this.#media.setAttribute("aria-hidden", "true");
    this.#media.dataset.inkbookScheme = "light";
    this.#surface = new StaticPreviewSurface(this.#media);
    this.#scheduler = new PreviewIdleScheduler(workScheduler);
    this.#descriptor = descriptor;
    this.#mountedIdentity = undefined;
    this.setAspectRatio(descriptor.aspectRatio);
    this.#startPreparation();
  }

  public readonly setAspectRatio = (ratio: number): void => {
    if (Number.isFinite(ratio) && ratio > 0)
      this.#media.setCssProps({ "--inkbook-preview-aspect-ratio": String(ratio) });
  };

  public readonly setColorScheme = (scheme: InkbookColorScheme): void => {
    this.#media.dataset.inkbookScheme = scheme;
    this.#surface?.setColorScheme(scheme);
  };

  public readonly refresh = (): void => {
    if (this.#disposed) return;
    if (!this.element.hidden) this.#releaseRequested = false;
    this.#surface?.refresh();
    if (this.element.hidden && this.#readinessRequests === 0) return;
    this.#startPreparation();
    if (this.#prepared === undefined) return;
    this.setAspectRatio(this.#descriptor.aspectRatio);
    this.#surface?.setSvg(this.#prepared);
    this.#prepared = undefined;
    this.#mountedIdentity = this.#descriptor.contentIdentity;
  };

  public readonly setBackgroundWait = (
    wait: (() => Promise<void> | undefined) | undefined,
  ): void => {
    this.#scheduler.setBackgroundWait(wait);
  };

  public readonly ensureReady = async (): Promise<void> => {
    if (this.#disposed) return;
    this.#releaseRequested = false;
    this.#readinessRequests += 1;
    try {
      this.#startPreparation();
      while (this.#pending !== undefined || this.#sourcePending !== undefined) {
        await this.#sourcePending;
        await this.#pending;
      }
      if (this.#failure !== undefined) throw this.#failure;
      this.refresh();
      if (!this.#disposed && !this.#releaseRequested && this.element.isConnected)
        await this.#surface?.ensureMounted();
    } finally {
      this.#readinessRequests -= 1;
      if (this.#releaseRequested) this.releaseHiddenSurface();
    }
  };

  public readonly releaseHiddenSurface = (): void => {
    if (this.#disposed || !this.element.hidden) return;
    this.#releaseRequested = true;
    this.#generation += 1;
    this.#preparationAbort?.abort();
    this.#prepared = undefined;
    this.#mountedIdentity = undefined;
    if (this.#readinessRequests > 0) return;
    this.#surface?.dispose();
    this.#surface = undefined;
  };

  public readonly setDescriptor = (descriptor: InkbookLockedPreviewDescriptor): void => {
    if (this.#disposed) return;
    this.#sourceGeneration += 1;
    this.#sourceAbort?.abort();
    this.#update(descriptor);
  };

  public readonly setSource = (source: string): Promise<PreviewContentIdentity | undefined> => {
    if (this.#disposed) return Promise.resolve(undefined);
    this.#sourceAbort?.abort();
    const abort = new AbortController();
    this.#sourceAbort = abort;
    const task = this.#loadSource(source, abort).finally(() => {
      if (this.#sourcePending === task) this.#sourcePending = undefined;
      if (this.#sourceAbort === abort) this.#sourceAbort = undefined;
    });
    this.#sourcePending = task;
    return task;
  };

  async #loadSource(
    source: string,
    abort: AbortController,
  ): Promise<PreviewContentIdentity | undefined> {
    const generation = ++this.#sourceGeneration;
    try {
      const ownerWindow = this.element.ownerDocument.defaultView;
      if (ownerWindow === null) throw new Error("The Inkbook preview has no owning window.");
      if (this.sourceLoader?.documents.loadPreviewSource !== undefined) {
        const ready = this.#scheduler.waitForBackground(abort.signal);
        if (ready !== undefined) await ready;
      }
      if (abort.signal.aborted) return undefined;
      const loaded = await (this.sourceLoader?.documents.loadPreviewSource === undefined
        ? loadValidatedPreviewSvg(source, ownerWindow, {
            waitForBackground: () => this.#scheduler.waitForBackground(abort.signal),
            signal: abort.signal,
            workScheduler: this.workScheduler,
          })
        : this.sourceLoader.documents.loadPreviewSource(
            this.sourceLoader.documentId,
            source,
            () => this.#scheduler.waitForBackground(abort.signal),
            ownerWindow,
          ));
      if (this.#disposed || generation !== this.#sourceGeneration) return undefined;
      this.#update(loaded);
      return loaded.contentIdentity;
    } catch (error: unknown) {
      if (abort.signal.aborted || this.#disposed || generation !== this.#sourceGeneration)
        return undefined;
      throw error;
    }
  }

  public readonly dispose = (): void => {
    this.#disposed = true;
    this.#sourceAbort?.abort();
    this.#preparationAbort?.abort();
    this.#prepared = undefined;
    this.#sourceGeneration += 1;
    this.#scheduler.dispose();
    this.#surface?.dispose();
    this.#surface = undefined;
  };

  #matchesMounted(identity: PreviewContentIdentity): boolean {
    return (
      this.#mountedIdentity !== undefined &&
      samePreviewContentIdentity(this.#mountedIdentity, identity)
    );
  }

  #update(descriptor: InkbookLockedPreviewDescriptor): void {
    if (samePreviewContentIdentity(this.#descriptor.contentIdentity, descriptor.contentIdentity))
      return;
    this.#descriptor = descriptor;
    this.#generation += 1;
    this.#preparationAbort?.abort();
    this.#prepared = undefined;
    this.#failure = undefined;
    if (this.#matchesMounted(descriptor.contentIdentity)) return;
    this.#startPreparation();
  }

  #startPreparation(): void {
    if (
      this.#disposed ||
      (this.#releaseRequested && this.element.hidden) ||
      (this.element.hidden && this.#readinessRequests === 0) ||
      this.#prepared !== undefined ||
      this.#failure !== undefined ||
      this.#matchesMounted(this.#descriptor.contentIdentity)
    )
      return;
    this.#pending ??= this.#prepare().finally(() => {
      this.#pending = undefined;
      this.#startPreparation();
    });
  }

  async #prepare(): Promise<void> {
    const target = this.#generation;
    const abort = new AbortController();
    this.#preparationAbort = abort;
    const isCancelled = (): boolean =>
      this.#disposed ||
      abort.signal.aborted ||
      target !== this.#generation ||
      (this.element.hidden && this.#readinessRequests === 0);
    try {
      const surface = (this.#surface ??= new StaticPreviewSurface(this.#media));
      surface.setColorScheme(this.#media.dataset.inkbookScheme === "dark" ? "dark" : "light");
      const svg = await createPreviewSvgAsync(
        surface.drawingDocument ?? this.element.ownerDocument,
        this.#descriptor.safeSvg,
        {
          checkpoint: (initial) => this.#scheduler.checkpoint(initial, abort.signal),
          isCancelled,
          workScheduler: this.workScheduler,
        },
      );
      if (isCancelled()) return;
      this.#prepared = svg;
      this.refresh();
    } catch (error: unknown) {
      if (!isCancelled() && target === this.#generation)
        this.#failure = error instanceof Error ? error : new Error("Preview preparation failed.");
    } finally {
      if (this.#preparationAbort === abort) this.#preparationAbort = undefined;
    }
  }
}
