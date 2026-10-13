import type { RenderBand } from "../commands/render-bands";
import type { AppliedElementMutation, ElementMutation, StoreDelta } from "./types";

/** Identity witnesses describe exact orders, independently of record versions. */
export type HistoryBandState = Readonly<Record<RenderBand, object>>;

export class HistoryBandStates {
  #current: HistoryBandState = Object.freeze({ content: {}, highlight: {} });
  readonly #transitions = new WeakMap<
    AppliedElementMutation,
    { readonly before: HistoryBandState; readonly after: HistoryBandState }
  >();

  public capture(): HistoryBandState {
    return this.#current;
  }

  public trusts(requested: ElementMutation, transition: AppliedElementMutation): boolean {
    const retained = this.#transitions.get(transition);
    if (retained === undefined) return false;
    const source =
      requested === transition.forward
        ? retained.before
        : requested === transition.reverse
          ? retained.after
          : undefined;
    return (
      source !== undefined &&
      source.content === this.#current.content &&
      source.highlight === this.#current.highlight
    );
  }

  /** Called only after successful adoption and before notifying Store observers. */
  public publish(
    delta: StoreDelta,
    transition?: AppliedElementMutation,
    requested?: ElementMutation,
  ): void {
    const retained = transition === undefined ? undefined : this.#transitions.get(transition);
    if (retained !== undefined && requested !== undefined) {
      // Private canonical replay proves these frozen destination orders even
      // after fallback validation. Public replay never restores this lineage.
      this.#current = requested === transition!.reverse ? retained.before : retained.after;
      return;
    }
    const before = this.#current;
    this.#current = Object.freeze({
      content: delta.dirtyBands.content ? {} : before.content,
      highlight: delta.dirtyBands.highlight ? {} : before.highlight,
    });
    if (transition !== undefined && retained === undefined) this.retain(transition, before);
  }

  public retain(transition: AppliedElementMutation, before: HistoryBandState): void {
    this.#transitions.set(transition, { before, after: this.#current });
  }
}
