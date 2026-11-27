import { Platform } from "obsidian";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { createPreviewSvgAsync } from "./safe-preview-builder";
import { PreviewIdleScheduler } from "./preview-idle-scheduler";
import { PreviewTextAlternative } from "./preview-text-alternative";
import type { InkbookDocumentRecognitionPort } from "./document-recognition";
import type { InkbookColorScheme } from "../../theme/color-scheme";
import { StaticPreviewSurface } from "../../../rendering/scene";

import {
  loadValidatedPreviewSvg,
  samePreviewContentIdentity,
  type PreviewContentIdentity,
} from "./safe-preview-svg";

export interface InkbookLockedPreviewGeometry {
  readonly aspectRatio: number;
  readonly contentIdentity: PreviewContentIdentity;
}

export interface InkbookLockedPreviewDescriptor extends InkbookLockedPreviewGeometry {
  readonly safeSvg?: string;
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
  readonly setLayoutVisible: (visible: boolean) => void;
  readonly element: HTMLButtonElement;
  readonly refresh: () => void;
  readonly getMountedIdentity: () => PreviewContentIdentity | undefined;
  readonly ensureReady: () => Promise<void>;
  readonly setBackgroundWait: (wait: (() => Promise<void> | undefined) | undefined) => void;
  readonly dispose: () => void;
  readonly setDescriptor: (descriptor: InkbookLockedPreviewDescriptor) => void;
  readonly setColorScheme: (scheme: InkbookColorScheme) => void;
  readonly setAspectRatio: (aspectRatio: number) => void;
  readonly setSource: (source: string) => Promise<PreviewContentIdentity | undefined>;
}

interface LockedPreviewOptions {
  readonly documentId: string;
  readonly documents: InkbookDocumentRecognitionPort;
  readonly waitForLayout?: boolean;
}

interface PreparedPreview {
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly svg: SVGSVGElement;
  readonly text: HTMLElement | undefined;
}

export function createInkbookLockedPreview(
  button: HTMLButtonElement,
  descriptor: InkbookLockedPreviewDescriptor,
  workScheduler: WorkScheduler,
  options?: LockedPreviewOptions,
): InkbookLockedPreviewSurface {
  return new LockedPreview(button, descriptor, workScheduler, options);
}

class LockedPreview implements InkbookLockedPreviewSurface {
  readonly #media: HTMLDivElement;
  #surface: StaticPreviewSurface | undefined;
  readonly #scheduler: PreviewIdleScheduler;
  readonly #loadOnDemand: boolean;
  #descriptor: InkbookLockedPreviewDescriptor;
  #mountedIdentity: PreviewContentIdentity | undefined;
  #sourceGeneration = 0;
  #sourceAbort: AbortController | undefined;
  #sourcePending: Promise<PreviewContentIdentity | undefined> | undefined;
  #generation = 0;
  #disposed = false;
  #prepared: PreparedPreview | undefined;
  #publishedText: HTMLElement | undefined;
  #pending: Promise<void> | undefined;
  #preparationAbort: AbortController | undefined;
  #mountAbort: AbortController | undefined;
  #readinessRequests = 0;
  #failure: Error | undefined;
  #releaseRequested = false;
  #layoutVisible: boolean;

  public constructor(
    public readonly element: HTMLButtonElement,
    descriptor: InkbookLockedPreviewDescriptor,
    private readonly workScheduler: WorkScheduler,
    private readonly sourceLoader?: LockedPreviewOptions,
  ) {
    if (Platform.isAndroidApp) element.classList.add("inkbook-locked-preview-android");
    this.#media = element.createDiv({ cls: "inkbook-locked-preview-media" });
    this.#media.setAttribute("aria-hidden", "true");
    this.#media.dataset.inkbookScheme = "light";
    this.#layoutVisible = sourceLoader?.waitForLayout !== true;
    this.#scheduler = new PreviewIdleScheduler(workScheduler);
    this.#loadOnDemand = descriptor.safeSvg === undefined;
    this.#descriptor = descriptor;
    this.#mountedIdentity = undefined;
    this.setAspectRatio(descriptor.aspectRatio);
    this.#startPreparation();
  }

  public readonly setAspectRatio = (ratio: number): void => {
    if (Number.isFinite(ratio) && ratio > 0)
      this.#media.setCssProps({ "--inkbook-preview-aspect-ratio": String(ratio) });
  };

  public readonly getMountedIdentity = (): PreviewContentIdentity | undefined =>
    this.#mountedIdentity;

  public readonly setColorScheme = (scheme: InkbookColorScheme): void => {
    this.#media.dataset.inkbookScheme = scheme;
    this.#surface?.setColorScheme(scheme);
  };

  public readonly setLayoutVisible = (visible: boolean): void => {
    if (this.#disposed || this.#layoutVisible === visible) return;
    this.#layoutVisible = visible;
    if (visible) {
      this.#failure = undefined;
      this.refresh();
    }
    // The active scene owns its hidden button until handoff, reversal or disposal.
    else if (this.#readinessRequests === 0 && !this.element.hidden) this.#releaseSurface();
  };

  public readonly refresh = (): void => {
    if (this.#disposed) return;
    if (!this.element.hidden) this.#releaseRequested = false;
    this.#surface?.refresh();
    this.#startPreparation();
  };

  readonly #publishPrepared = (surface: StaticPreviewSurface, document: Document): void => {
    const prepared = this.#prepared;
    const parent = this.element.parentElement;
    if (
      prepared === undefined ||
      prepared.generation !== this.#generation ||
      prepared.signal.aborted ||
      this.#disposed ||
      this.#releaseRequested ||
      (this.element.hidden && this.#readinessRequests === 0) ||
      surface !== this.#surface ||
      parent === null
    )
      return;
    const source = this.sourceLoader;
    const identity = this.#descriptor.contentIdentity;
    if (source?.documents.canPublishPreview?.(source.documentId, identity) === false) {
      this.#prepared = undefined;
      this.#failure = new Error("The Inkbook preview source changed while preparing its display.");
      this.#mountAbort?.abort();
      this.#mountAbort = undefined;
      return;
    }
    if (!surface.mountSvg(prepared.svg, document)) return;
    this.setAspectRatio(this.#descriptor.aspectRatio);
    this.#publishedText?.remove();
    if (prepared.text !== undefined) {
      // Insert after the persistent label so the handoff keeps its original sibling anchor.
      parent.append(prepared.text);
    }
    this.#publishedText = prepared.text;
    this.#prepared = undefined;
    this.#mountedIdentity = identity;
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
      this.#failure = undefined;
      this.#startPreparation();
      await this.#waitForCurrentSurface();
    } finally {
      this.#readinessRequests -= 1;
      if (this.#releaseRequested) this.releaseHiddenSurface();
    }
  };

  async #waitForCurrentSurface(): Promise<void> {
    while (!this.#disposed && !this.#releaseRequested) {
      if (this.#pending !== undefined || this.#sourcePending !== undefined) {
        await this.#sourcePending;
        await this.#pending;
        continue;
      }
      if (this.#failure !== undefined) throw this.#failure;
      this.refresh();
      if (this.#pending !== undefined) continue;
      const identity = this.#descriptor.contentIdentity;
      if (!this.#matchesMounted(identity) && this.#prepared === undefined)
        throw new Error("The Inkbook preview is not ready.");
      // A detached handoff stages its complete preview and publishes on frame load after attachment.
      if (!this.element.isConnected) return;
      const generation = this.#generation;
      const mounted = await this.#ensureMounted();
      if (
        mounted &&
        generation === this.#generation &&
        this.#matchesMounted(this.#descriptor.contentIdentity) &&
        this.#sourcePending === undefined
      )
        return;
    }
  }

  public readonly releaseHiddenSurface = (): void => {
    if (this.#disposed || !this.element.hidden) return;
    this.#releaseRequested = true;
    this.#releaseSurface();
  };

  #releaseSurface(): void {
    this.#generation += 1;
    this.#preparationAbort?.abort();
    this.#mountAbort?.abort();
    this.#mountAbort = undefined;
    this.#prepared = undefined;
    this.#publishedText?.remove();
    this.#publishedText = undefined;
    this.#mountedIdentity = undefined;
    this.#surface?.dispose();
    this.#surface = undefined;
  }

  public readonly setDescriptor = (descriptor: InkbookLockedPreviewDescriptor): void => {
    if (this.#disposed) return;
    if (!samePreviewContentIdentity(this.#descriptor.contentIdentity, descriptor.contentIdentity)) {
      this.#sourceGeneration += 1;
      this.#sourceAbort?.abort();
    }
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
            abort.signal,
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
    this.#mountAbort?.abort();
    this.#mountAbort = undefined;
    this.#prepared = undefined;
    this.#publishedText?.remove();
    this.#publishedText = undefined;
    this.#sourceGeneration += 1;
    this.#scheduler.dispose();
    this.#surface?.dispose();
    this.#surface = undefined;
  };

  async #ensureMounted(): Promise<boolean> {
    const surface = this.#surface;
    if (surface === undefined) return false;
    const abort = (this.#mountAbort ??= new AbortController());
    try {
      const document = await surface.ensureMounted(abort.signal);
      return this.#surface === surface && surface.drawingDocument === document;
    } catch (error: unknown) {
      if (!abort.signal.aborted) throw error;
      return false;
    }
  }

  #matchesMounted(identity: PreviewContentIdentity): boolean {
    return (
      this.#mountedIdentity !== undefined &&
      samePreviewContentIdentity(this.#mountedIdentity, identity)
    );
  }

  #update(descriptor: InkbookLockedPreviewDescriptor): void {
    if (samePreviewContentIdentity(this.#descriptor.contentIdentity, descriptor.contentIdentity)) {
      if (this.#failure !== undefined) {
        this.#failure = undefined;
        this.#generation += 1;
        this.#startPreparation();
      }
      return;
    }
    this.#descriptor = this.#loadOnDemand
      ? { aspectRatio: descriptor.aspectRatio, contentIdentity: descriptor.contentIdentity }
      : descriptor;
    if (!this.#layoutVisible) this.setAspectRatio(descriptor.aspectRatio);
    this.#generation += 1;
    this.#preparationAbort?.abort();
    this.#mountAbort?.abort();
    this.#mountAbort = undefined;
    this.#prepared = undefined;
    this.#failure = undefined;
    if (this.#matchesMounted(descriptor.contentIdentity)) return;
    this.#startPreparation();
  }

  #startPreparation(): void {
    if (
      this.#disposed ||
      (this.#releaseRequested && this.element.hidden) ||
      ((!this.#layoutVisible || this.element.hidden) && this.#readinessRequests === 0) ||
      this.#prepared !== undefined ||
      this.#failure !== undefined ||
      this.#matchesMounted(this.#descriptor.contentIdentity)
    )
      return;
    const generation = this.#generation;
    this.#pending ??= this.#prepare().finally(() => {
      this.#pending = undefined;
      if (generation !== this.#generation) this.#startPreparation();
    });
  }

  async #loadMarkup(identity: PreviewContentIdentity, signal: AbortSignal): Promise<string> {
    const ownerWindow = this.element.ownerDocument.defaultView;
    const source = this.sourceLoader;
    const load = source?.documents.loadPreviewSource;
    if (ownerWindow === null || source === undefined || load === undefined)
      throw new Error("The Inkbook preview source is unavailable.");
    const loaded = await load(
      source.documentId,
      identity,
      () => this.#scheduler.waitForBackground(signal),
      ownerWindow,
      signal,
    );
    if (!samePreviewContentIdentity(loaded.contentIdentity, identity))
      throw new Error("The Inkbook preview source changed while loading.");
    return loaded.safeSvg;
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
      const markup =
        this.#descriptor.safeSvg ??
        (await this.#loadMarkup(this.#descriptor.contentIdentity, abort.signal));
      if (isCancelled()) return;
      const surface = (this.#surface ??= new StaticPreviewSurface(
        this.#media,
        this.#publishPrepared,
      ));
      surface.setColorScheme(this.#media.dataset.inkbookScheme === "dark" ? "dark" : "light");
      const text = new PreviewTextAlternative(this.element.ownerDocument);
      const svg = await createPreviewSvgAsync(
        surface.drawingDocument ?? this.element.ownerDocument,
        markup,
        {
          checkpoint: (initial) => this.#scheduler.checkpoint(initial, abort.signal),
          isCancelled,
          workScheduler: this.workScheduler,
          textAlternative: text,
        },
      );
      if (isCancelled() || svg === undefined) return;
      this.#prepared = { generation: target, signal: abort.signal, svg, text: text.finish() };
      this.refresh();
    } catch (error: unknown) {
      if (!isCancelled() && target === this.#generation)
        this.#failure = error instanceof Error ? error : new Error("Preview preparation failed.");
    } finally {
      if (this.#preparationAbort === abort) this.#preparationAbort = undefined;
    }
  }
}
