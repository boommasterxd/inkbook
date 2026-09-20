import { Platform } from "obsidian";
import { createPreviewSvgAsync } from "./safe-preview-builder";
import { PreviewIdleScheduler } from "./preview-idle-scheduler";

import {
  createPreviewSvg,
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
  readonly setPreviewAspectRatio?: (aspectRatio: number) => void;
  readonly refreshPreview?: () => void;
  readonly ensurePreviewReady?: () => Promise<void>;
  readonly setPreviewBackgroundWait?: (wait: (() => Promise<void>) | undefined) => void;
  readonly setPreviewSource?: (source: string) => Promise<void>;
}

export interface InkbookLockedPreviewSurface {
  readonly element: HTMLButtonElement;
  readonly refresh: () => void;
  readonly ensureReady: () => Promise<void>;
  readonly setBackgroundWait: (wait: (() => Promise<void>) | undefined) => void;
  readonly dispose: () => void;
  readonly setDescriptor: (descriptor: InkbookLockedPreviewDescriptor) => void;
  readonly setAspectRatio: (aspectRatio: number) => void;
  readonly setSource: (source: string) => Promise<PreviewContentIdentity | undefined>;
}

export function createInkbookLockedPreview(
  button: HTMLButtonElement,
  descriptor: InkbookLockedPreviewDescriptor,
): InkbookLockedPreviewSurface {
  return new LockedPreview(button, descriptor);
}

class LockedPreview implements InkbookLockedPreviewSurface {
  readonly #media: HTMLDivElement;
  readonly #window: Window;
  readonly #scheduler: PreviewIdleScheduler;
  #descriptor: InkbookLockedPreviewDescriptor;
  #mountedIdentity: PreviewContentIdentity;
  #sourceGeneration = 0;
  #sourceAbort: AbortController | undefined;
  #sourcePending: Promise<PreviewContentIdentity | undefined> | undefined;
  #generation = 0;
  #disposed = false;
  #prepared: SVGSVGElement | undefined;
  #pending: Promise<void> | undefined;
  #failure: Error | undefined;

  public constructor(
    public readonly element: HTMLButtonElement,
    descriptor: InkbookLockedPreviewDescriptor,
  ) {
    if (Platform.isAndroidApp) element.classList.add("inkbook-locked-preview-android");
    this.#media = element.createDiv({ cls: "inkbook-locked-preview-media" });
    this.#media.setAttribute("aria-hidden", "true");
    const ownerWindow = element.ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("The Inkbook preview has no owning window.");
    this.#window = ownerWindow;
    this.#scheduler = new PreviewIdleScheduler(ownerWindow);
    this.#descriptor = descriptor;
    this.#mountedIdentity = descriptor.contentIdentity;
    this.setAspectRatio(descriptor.aspectRatio);
    this.#media.replaceChildren(createPreviewSvg(element.ownerDocument, descriptor.safeSvg));
  }

  public readonly setAspectRatio = (ratio: number): void => {
    if (Number.isFinite(ratio) && ratio > 0)
      this.#media.setCssProps({ "--inkbook-preview-aspect-ratio": String(ratio) });
  };

  public readonly refresh = (): void => {
    if (this.#disposed || this.element.hidden || this.#prepared === undefined) return;
    this.setAspectRatio(this.#descriptor.aspectRatio);
    this.#media.replaceChildren(this.#prepared);
    this.#prepared = undefined;
    this.#mountedIdentity = this.#descriptor.contentIdentity;
  };

  public readonly setBackgroundWait = (wait: (() => Promise<void>) | undefined): void => {
    this.#scheduler.setBackgroundWait(wait);
  };

  public readonly ensureReady = async (): Promise<void> => {
    this.#scheduler.promote();
    try {
      while (this.#pending !== undefined || this.#sourcePending !== undefined) {
        await this.#sourcePending;
        await this.#pending;
      }
    } finally {
      this.#scheduler.demote();
    }
    if (this.#failure !== undefined) throw this.#failure;
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
      const loaded = await loadValidatedPreviewSvg(
        source,
        this.#window,
        () => this.#scheduler.waitForBackground(abort.signal),
        abort.signal,
      );
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
    this.#prepared = undefined;
    this.#sourceGeneration += 1;
    this.#scheduler.dispose();
  };

  #update(descriptor: InkbookLockedPreviewDescriptor): void {
    if (samePreviewContentIdentity(this.#descriptor.contentIdentity, descriptor.contentIdentity))
      return;
    this.#descriptor = descriptor;
    this.#generation += 1;
    this.#prepared = undefined;
    this.#failure = undefined;
    if (samePreviewContentIdentity(this.#mountedIdentity, descriptor.contentIdentity)) return;
    this.#startPreparation();
  }

  #startPreparation(): void {
    if (
      this.#disposed ||
      this.#prepared !== undefined ||
      this.#failure !== undefined ||
      samePreviewContentIdentity(this.#mountedIdentity, this.#descriptor.contentIdentity)
    )
      return;
    this.#pending ??= this.#prepare()
      .catch((error: unknown) => {
        this.#failure = error instanceof Error ? error : new Error("Preview preparation failed.");
      })
      .finally(() => {
        this.#pending = undefined;
        this.#startPreparation();
      });
  }

  async #prepare(): Promise<void> {
    while (!this.#disposed) {
      if (samePreviewContentIdentity(this.#mountedIdentity, this.#descriptor.contentIdentity))
        return;
      const target = this.#generation;
      const svg = await createPreviewSvgAsync(
        this.element.ownerDocument,
        this.#descriptor.safeSvg,
        {
          checkpoint: () => this.#scheduler.checkpoint(),
          isCancelled: () => this.#disposed || target !== this.#generation,
        },
      );
      if (this.#disposed) return;
      if (target !== this.#generation) continue;
      this.#prepared = svg;
      this.refresh();
      return;
    }
  }
}
