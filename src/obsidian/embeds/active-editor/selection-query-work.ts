import type { SelectionPreviewOptions } from "./selection-preview-contracts";

const STEPS_PER_FRAME = 64;
type SelectionQueryOptions = Pick<
  SelectionPreviewOptions,
  | "frameScheduler"
  | "selection"
  | "selectionSignal"
  | "selectionWorkBudget"
  | "setSelection"
  | "store"
>;

/** Drains bounded geometry steps while retaining no work after cancellation. */
export class SelectionQueryWork {
  readonly #options: SelectionQueryOptions;
  readonly #steps: Generator<void, ReadonlySet<string>>;
  readonly #selection: ReadonlySet<string>;
  #frame: number | undefined;
  #unsubscribe: (() => void) | undefined;
  #finished = false;
  #started = false;
  #changed = false;

  public constructor(options: SelectionQueryOptions, steps: Generator<void, ReadonlySet<string>>) {
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
    this.#advance();
    return this.#changed;
  }

  public readonly cancel = (): void => {
    if (this.#finished) return;
    this.#finished = true;
    if (this.#frame !== undefined) this.#options.frameScheduler?.cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#options.selectionSignal?.removeEventListener("abort", this.cancel);
    this.#steps.return(this.#selection);
  };

  #advance(): void {
    try {
      this.#runSlice();
    } catch (error) {
      this.cancel();
      throw error;
    }
  }

  #runSlice(): void {
    this.#frame = undefined;
    if (this.#finished) return;
    const current = this.#options.selection();
    if (current !== this.#selection && !sameMembers(current, this.#selection)) return this.cancel();
    const scheduler = this.#options.frameScheduler;
    const budget = this.#options.selectionWorkBudget;
    const deadline = budget === undefined ? Infinity : budget.now() + budget.sliceBudgetMs();
    for (let count = 0; scheduler === undefined || count < STEPS_PER_FRAME; count += 1) {
      const result = this.#steps.next();
      if (result.done) {
        this.cancel();
        this.#changed = !sameMembers(result.value, this.#selection);
        if (this.#changed) this.#options.setSelection(result.value);
        return;
      }
      if (scheduler !== undefined && budget !== undefined && budget.now() >= deadline) break;
    }
    this.#frame = scheduler.requestAnimationFrame(() => this.#advance());
  }
}

function sameMembers(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}
