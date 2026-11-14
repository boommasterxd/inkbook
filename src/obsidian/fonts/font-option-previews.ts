import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import type { FontPreviewSource } from "./font-preview-source";
import { resolveFontPreview } from "./font-preview-source";
import {
  applyFontPreview,
  captureFontPreviewStyle,
  loadNativeFontPreview,
  type FontPreviewBudget,
  type NativeFontPreview,
} from "./native-font-preview";

const MAX_FACES = 8;
const MAX_LEASES = 32;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;

interface PreviewLease {
  readonly element: HTMLElement;
  readonly restore: () => void;
  readonly release: () => void;
}

interface RetainedFace {
  readonly preview: NativeFontPreview;
  references: number;
}

interface PreviewEntry {
  readonly family: string;
  readonly leases: Set<PreviewLease>;
  readonly cancellation: AbortController;
  state: "queued" | "loading" | "blocked" | "ready" | "failed";
  budget?: FontPreviewBudget;
  id?: string;
  face?: RetainedFace;
}

export interface FontOptionPreviewOptions extends FontPreviewSource {
  readonly document: Document;
  readonly scheduler: WorkScheduler;
}

/** One surface owns a serial, bounded set of transient fonts for visible labels only. */
export class FontOptionPreviews {
  readonly #options: FontOptionPreviewOptions;
  readonly #entries = new Map<string, PreviewEntry>();
  readonly #faces = new Map<string, RetainedFace>();
  readonly #leases = new Map<HTMLElement, PreviewLease>();
  #running: Promise<void> | undefined;
  #bytes = 0;
  #decodedBytes = 0;
  #disposed = false;

  public constructor(options: FontOptionPreviewOptions) {
    this.#options = options;
  }

  public acquire(element: HTMLElement, family: string): () => void {
    this.#leases.get(element)?.release();
    if (this.#disposed || this.#leases.size >= MAX_LEASES) return () => undefined;
    if (element.ownerDocument !== this.#options.document)
      throw new Error("Font preview window mismatch.");
    const entry = this.#entries.get(family) ?? this.#createEntry(family);
    const restoreStyle = captureFontPreviewStyle(element);
    const previousState = element.dataset.inkbookFontPreview;
    let released = false;
    const lease: PreviewLease = {
      element,
      restore: () => {
        restoreStyle();
        if (previousState === undefined) delete element.dataset.inkbookFontPreview;
        else element.dataset.inkbookFontPreview = previousState;
      },
      release: () => {
        if (released) return;
        released = true;
        this.#release(entry, lease);
      },
    };
    entry.leases.add(lease);
    this.#leases.set(element, lease);
    if (entry.face !== undefined) applyFontPreview(element, entry.face.preview);
    element.dataset.inkbookFontPreview =
      entry.state === "ready" ? "ready" : entry.state === "failed" ? "unavailable" : "loading";
    this.#start();
    return lease.release;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const lease of [...this.#leases.values()]) lease.release();
  }

  #createEntry(family: string): PreviewEntry {
    const entry: PreviewEntry = {
      family,
      leases: new Set(),
      cancellation: new AbortController(),
      state: "queued",
    };
    this.#entries.set(family, entry);
    return entry;
  }

  #release(entry: PreviewEntry, lease: PreviewLease): void {
    lease.restore();
    this.#leases.delete(lease.element);
    entry.leases.delete(lease);
    if (entry.leases.size !== 0) return;
    entry.cancellation.abort();
    this.#entries.delete(entry.family);
    const face = entry.face;
    if (face !== undefined && --face.references === 0) {
      face.preview.dispose();
      this.#faces.delete(entry.id!);
      this.#bytes -= face.preview.bytes;
      this.#decodedBytes -= face.preview.decodedBytes;
    }
    this.#start();
  }

  #fits(budget: FontPreviewBudget): boolean {
    return (
      this.#faces.size < MAX_FACES &&
      this.#bytes + budget.bytes <= MAX_BYTES &&
      this.#decodedBytes + budget.decodedBytes <= MAX_DECODED_BYTES
    );
  }

  #next(): PreviewEntry | undefined {
    return [...this.#entries.values()].find(
      (entry) =>
        entry.state === "queued" ||
        (entry.state === "blocked" &&
          (this.#faces.has(entry.id!) || (entry.budget !== undefined && this.#fits(entry.budget)))),
    );
  }

  #start(): void {
    if (this.#disposed || this.#running !== undefined || this.#next() === undefined) return;
    this.#running = this.#drain().finally(() => {
      this.#running = undefined;
      this.#start();
    });
  }

  async #drain(): Promise<void> {
    let entry = this.#next();
    while (entry !== undefined && !this.#disposed) {
      entry.state = "loading";
      try {
        await this.#load(entry);
      } catch {
        if (!entry.cancellation.signal.aborted) this.#mark(entry, "failed");
      }
      entry = this.#next();
    }
  }

  async #load(entry: PreviewEntry): Promise<void> {
    const signal = entry.cancellation.signal;
    const cached = entry.id === undefined ? undefined : this.#faces.get(entry.id);
    if (cached !== undefined) {
      this.#attach(entry, cached);
      return;
    }
    const resource = await resolveFontPreview(
      entry.family,
      this.#options.scheduler,
      this.#options,
      signal,
    );
    signal.throwIfAborted();
    if (resource === undefined) {
      this.#mark(entry, "failed");
      return;
    }
    entry.id = resource.id;
    const existing = this.#faces.get(resource.id);
    if (existing !== undefined) {
      this.#attach(entry, existing);
      return;
    }
    const preview = await loadNativeFontPreview(resource, {
      document: this.#options.document,
      scheduler: this.#options.scheduler,
      signal,
      admit: (budget) => {
        entry.budget = budget;
        return this.#fits(budget);
      },
    });
    if (preview === undefined) {
      entry.state = "blocked";
      return;
    }
    if (signal.aborted || this.#disposed) {
      preview.dispose();
      return;
    }
    const face = { preview, references: 0 };
    this.#faces.set(resource.id, face);
    this.#bytes += preview.bytes;
    this.#decodedBytes += preview.decodedBytes;
    this.#attach(entry, face);
  }

  #attach(entry: PreviewEntry, face: RetainedFace): void {
    entry.face = face;
    face.references += 1;
    for (const lease of entry.leases) applyFontPreview(lease.element, face.preview);
    this.#mark(entry, "ready");
  }

  #mark(entry: PreviewEntry, state: "ready" | "failed"): void {
    entry.state = state;
    for (const lease of entry.leases)
      lease.element.dataset.inkbookFontPreview = state === "ready" ? "ready" : "unavailable";
  }
}
