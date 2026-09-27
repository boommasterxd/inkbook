import type { SelectionPreviewOptions } from "./selection-preview-contracts";
import type { SelectionQueryStep } from "../../../editor/selection/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";

// Keep 64 expensive batches while allowing cheap bounds decisions to share a slice.
const WORK_UNITS_PER_FRAME = 4096;
const GEOMETRY_BATCH_WORK_UNITS = 64;
type SelectionQueryOptions = Pick<
  SelectionPreviewOptions,
  "selection" | "selectionSignal" | "setSelection" | "store"
> & { readonly workScheduler: WorkScheduler };

/** Drains bounded geometry steps while retaining no work after cancellation. */
export class SelectionQueryWork {
  readonly #options: SelectionQueryOptions;
  readonly #steps: Generator<SelectionQueryStep, ReadonlySet<string>>;
  readonly #selection: ReadonlySet<string>;
  #frame: number | undefined;
  #unsubscribe: (() => void) | undefined;
  #finished = false;
  #started = false;
  #changed = false;

  public constructor(
    options: SelectionQueryOptions,
    steps: Generator<SelectionQueryStep, ReadonlySet<string>>,
  ) {
    this.#options = options;
    this.#steps = steps;
    this.#selection = options.selection();
  }

  public start(): boolean {
    if (this.#started || this.#finished) return this.#changed;
    this.#started = true;
    if (this.#options.selectionSignal?.aborted === true) {
      this.cancel();
      return false;
    }
    this.#unsubscribe = this.#options.store.subscribe(this.cancel);
    this.#options.selectionSignal?.addEventListener("abort", this.cancel, { once: true });
    this.#advance(false);
    return this.#changed;
  }

  public readonly cancel = (): void => {
    if (this.#finished) return;
    this.#finished = true;
    if (this.#frame !== undefined) this.#options.workScheduler.cancelFrame(this.#frame);
    this.#frame = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#options.selectionSignal?.removeEventListener("abort", this.cancel);
    this.#steps.return(this.#selection);
  };

  #advance(admitted: boolean): void {
    try {
      this.#runSlice(admitted);
    } catch (error) {
      this.cancel();
      throw error;
    }
  }

  #runSlice(admitted: boolean): void {
    this.#frame = undefined;
    if (this.#finished) return;
    const current = this.#options.selection();
    if (current !== this.#selection && !sameMembers(current, this.#selection)) return this.cancel();
    const scheduler = this.#options.workScheduler;
    if (!admitted && scheduler.shouldYield()) return this.#scheduleFrame();
    let remaining = WORK_UNITS_PER_FRAME;
    while (remaining > 0) {
      const result = this.#steps.next();
      if (result.done) {
        this.cancel();
        this.#changed = !sameMembers(result.value, this.#selection);
        if (this.#changed) this.#options.setSelection(result.value);
        return;
      }
      // Keep large predicates within the existing batch charge and maximum 63-unit overrun.
      remaining -= Math.min(result.value ?? GEOMETRY_BATCH_WORK_UNITS, GEOMETRY_BATCH_WORK_UNITS);
      if (scheduler.shouldYield()) break;
    }
    this.#scheduleFrame();
  }

  #scheduleFrame(): void {
    this.#frame = this.#options.workScheduler.requestFrame(() => this.#advance(true), "frame");
  }
}

function sameMembers(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}
