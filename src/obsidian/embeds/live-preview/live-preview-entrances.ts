import type { ChangeDesc } from "@codemirror/state";

import { MARKDOWN_EMBED_LIMITS } from "../markdown-embed";
import type { PresentationEntranceState } from "../presentation/presentation-entrance";

interface EmbedEntrance {
  readonly documentId: string;
  readonly from: number;
  readonly to: number;
  readonly state: PresentationEntranceState;
}

export class LivePreviewEntrances {
  readonly #sourcePath: string | undefined;
  #entries = new Map<number, EmbedEntrance>();
  #entriesShared = false;
  #lastEnd = 0;

  constructor(sourcePath: string | undefined) {
    this.#sourcePath = sourcePath;
  }

  update(changes: ChangeDesc, sourcePath: string | undefined): LivePreviewEntrances {
    if (sourcePath !== this.#sourcePath) return new LivePreviewEntrances(sourcePath);
    if (changes.empty) return this;
    const updated = new LivePreviewEntrances(sourcePath);
    if (this.#entries.size === 0) return updated;
    if (changes.touchesRange(0, this.#lastEnd) === false) {
      updated.#entries = this.#entries;
      updated.#lastEnd = this.#lastEnd;
      this.#entriesShared = updated.#entriesShared = true;
      return updated;
    }
    for (const entry of this.#entries.values()) {
      let touched = false;
      changes.iterChangedRanges((from, to, newFrom, newTo) => {
        if (
          from < entry.to &&
          to > entry.from &&
          (from <= entry.from || to >= entry.to || to - from !== newTo - newFrom)
        )
          touched = true;
      });
      if (touched) continue;
      const from = changes.mapPos(entry.from, 1);
      updated.#retain({ ...entry, from, to: changes.mapPos(entry.to, -1) });
    }
    return updated;
  }

  stateFor(from: number, to: number, documentId: string): PresentationEntranceState {
    const existing = this.#entries.get(from);
    if (existing?.to === to && existing.documentId === documentId) return existing.state;
    const retained = existing !== undefined || this.#entries.size < MARKDOWN_EMBED_LIMITS.matches;
    const state = { presented: !retained };
    if (retained) this.#retain({ documentId, from, to, state });
    return state;
  }

  #retain(entry: EmbedEntrance): void {
    // A later recognition can add a widget to either CodeMirror state independently.
    if (this.#entriesShared) {
      this.#entries = new Map(this.#entries);
      this.#entriesShared = false;
    }
    this.#entries.set(entry.from, entry);
    this.#lastEnd = Math.max(this.#lastEnd, entry.to);
  }
}
