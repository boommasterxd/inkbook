import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type {
  PreparedStyleReplacement,
  StyleReplacementRequest,
} from "./prepared-style-replacement";

interface StylePreviewRequest extends StyleReplacementRequest {
  readonly mutationVersion: number;
}

/** Keeps slider input local, with one running preparation and one latest target. */
export class StylePreviewCoordinator {
  #request: StylePreviewRequest | undefined;
  #ready:
    | { readonly request: StylePreviewRequest; readonly prepared: PreparedStyleReplacement }
    | undefined;
  #abort: AbortController | undefined;
  #running: Promise<void> | undefined;
  #frame: number | undefined;
  #commitRequested = false;
  #committing = false;
  #disposed = false;

  public constructor(
    private readonly options: {
      readonly scheduler: WorkScheduler;
      readonly selection: () => ReadonlySet<string>;
      readonly mutationVersion: () => number;
      readonly prepare: (
        request: StyleReplacementRequest,
        signal: AbortSignal,
      ) => Promise<PreparedStyleReplacement | null>;
      readonly present: (prepared: PreparedStyleReplacement, signal: AbortSignal) => Promise<void>;
      readonly clear: (committed: boolean) => void;
      readonly commit: (
        request: StyleReplacementRequest,
        prepared: PreparedStyleReplacement,
        completed: () => void,
      ) => boolean;
    },
  ) {}

  public preview(controlId: string, value: boolean | number | string): void {
    if (this.#disposed || this.#committing) return;
    const selection = this.options.selection();
    this.#request = {
      controlId,
      value,
      selection,
      mutationVersion: this.options.mutationVersion(),
      isCurrent: () => !this.#disposed && this.options.selection() === selection,
    };
    this.#abort?.abort();
    this.schedule();
  }

  public commit(controlId: string, value: boolean | number | string): boolean {
    if (!this.#request || this.#request.controlId !== controlId || this.#disposed) return false;
    if (this.#committing) return true;
    if (this.#request.value !== value) this.preview(controlId, value);
    this.#commitRequested = true;
    if (this.#frame !== undefined) this.options.scheduler.cancelFrame(this.#frame);
    this.#frame = undefined;
    this.start();
    return true;
  }

  public cancel(): void {
    if (!this.#commitRequested) this.reset();
  }

  public invalidate(): void {
    const request = this.#request;
    if (!request) return;
    if (
      !request.isCurrent() ||
      (!this.#committing && request.mutationVersion !== this.options.mutationVersion())
    )
      this.reset();
  }

  public dispose(): void {
    this.#disposed = true;
    this.reset();
  }

  private schedule(): void {
    if (this.#running || this.#frame !== undefined || this.#disposed) return;
    this.#frame = this.options.scheduler.requestFrame(() => {
      this.#frame = undefined;
      this.start();
    }, "input");
  }

  private start(): void {
    if (this.#running || this.#committing || this.#disposed) return;
    this.#running = this.drain().finally(() => {
      this.#running = undefined;
      if (
        this.#request &&
        !this.#committing &&
        (this.#ready?.request !== this.#request || this.#commitRequested)
      )
        this.schedule();
    });
  }

  private async drain(): Promise<void> {
    while (this.#request && !this.#disposed && !this.#committing) {
      const request = this.#request;
      if (!request.isCurrent() || request.mutationVersion !== this.options.mutationVersion()) {
        this.reset();
        return;
      }
      const abort = new AbortController();
      this.#abort = abort;
      try {
        const prepared = await this.prepare(request, abort.signal);
        if (!prepared) continue;
        if (this.#commitRequested) {
          this.#committing = true;
          if (!prepared.changed || !this.options.commit(request, prepared, () => this.reset()))
            this.reset();
        }
        return;
      } catch {
        if (abort.signal.aborted || request !== this.#request) continue;
        this.reset();
        return;
      } finally {
        if (this.#abort === abort) this.#abort = undefined;
      }
    }
  }

  private async prepare(request: StylePreviewRequest, signal: AbortSignal) {
    if (this.#ready?.request === request) return this.#ready.prepared;
    const prepared = await this.options.prepare(request, signal);
    if (signal.aborted || request !== this.#request) return undefined;
    if (!prepared) {
      this.reset();
      return undefined;
    }
    await this.options.present(prepared, signal);
    if (signal.aborted || request !== this.#request) return undefined;
    this.#ready = { request, prepared };
    return prepared;
  }

  private reset(): void {
    const visible = this.#request !== undefined;
    const committed =
      this.#committing && this.#request?.mutationVersion !== this.options.mutationVersion();
    this.#abort?.abort();
    if (this.#frame !== undefined) this.options.scheduler.cancelFrame(this.#frame);
    this.#frame = undefined;
    this.#request = undefined;
    this.#ready = undefined;
    this.#commitRequested = false;
    this.#committing = false;
    if (visible) this.options.clear(committed);
  }
}
