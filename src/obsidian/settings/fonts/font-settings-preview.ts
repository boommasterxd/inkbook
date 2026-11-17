import {
  applyFontPreview,
  loadNativeFontPreview,
  type NativeFontPreview,
} from "../../fonts/native-font-preview";
import type { FontResourceV2 } from "../../../domain/schema/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";

/** Retains at most one native font and cancels stale preview publication. */
export class FontSettingsPreview<Face> {
  #native: NativeFontPreview | undefined;
  #generation = 0;
  #disposed = false;
  #pending: Face | undefined;
  #running: Promise<void> | undefined;
  #cancellation: AbortController | undefined;

  public constructor(
    private readonly sample: HTMLElement,
    private readonly options: {
      readonly resource: (
        face: Face,
        signal: AbortSignal,
        scheduler: WorkScheduler,
      ) => FontResourceV2 | Promise<FontResourceV2>;
      readonly scheduler: WorkScheduler | ((ownerWindow: Window | null) => WorkScheduler);
    },
    private readonly mutate: (update: () => void) => void,
  ) {}

  public get settled(): Promise<void> {
    return this.#running?.catch(() => undefined) ?? Promise.resolve();
  }

  public cancelPending(): void {
    this.#generation += 1;
    this.#pending = undefined;
    this.#cancellation?.abort();
  }

  public clear(): void {
    this.cancelPending();
    this.#native?.dispose();
    this.#native = undefined;
    this.sample.hidden = true;
  }

  public show(face: Face): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.clear();
    this.#pending = face;
    this.#running ??= this.#drain();
    return this.#running;
  }

  async #drain(): Promise<void> {
    try {
      while (this.#pending !== undefined && !this.#disposed) {
        const face = this.#pending;
        this.#pending = undefined;
        const cancellation = new AbortController();
        this.#cancellation = cancellation;
        try {
          await this.#load(face, cancellation.signal);
        } catch (error) {
          if (!cancellation.signal.aborted) throw error;
        }
      }
    } finally {
      this.#running = undefined;
      this.#cancellation = undefined;
    }
  }

  async #load(face: Face, signal: AbortSignal): Promise<void> {
    const generation = this.#generation;
    const scheduler =
      typeof this.options.scheduler === "function"
        ? this.options.scheduler(this.sample.ownerDocument.defaultView)
        : this.options.scheduler;
    const resource = await this.options.resource(face, signal, scheduler);
    signal.throwIfAborted();
    const native = await loadNativeFontPreview(resource, {
      document: this.sample.ownerDocument,
      scheduler,
      signal,
    });
    if (native === undefined) throw new Error("Font preview is unavailable.");
    if (this.#disposed || this.#generation !== generation) {
      native.dispose();
      return;
    }
    this.#native = native;
    this.mutate(() => {
      applyFontPreview(this.sample, native);
      this.sample.hidden = false;
    });
  }

  public dispose(): void {
    this.#disposed = true;
    this.clear();
  }
}
