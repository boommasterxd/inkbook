import type { ChangeDesc } from "@codemirror/state";

import { MARKDOWN_EMBED_LIMITS } from "./markdown-embed";
import type { PresentationEntranceState } from "./presentation-entrance";

interface EmbedEntrance {
  readonly documentId: string;
  readonly from: number;
  readonly to: number;
  readonly state: PresentationEntranceState;
}

export class LivePreviewEntrances {
  readonly #sourcePath: string | undefined;
  readonly #entries: Map<number, EmbedEntrance>;

  constructor(sourcePath: string | undefined, entries: EmbedEntrance[] = []) {
    this.#sourcePath = sourcePath;
    this.#entries = new Map(entries.map((entry) => [entry.from, entry]));
  }

  update(changes: ChangeDesc, sourcePath: string | undefined): LivePreviewEntrances {
    if (sourcePath !== this.#sourcePath) return new LivePreviewEntrances(sourcePath);
    if (changes.empty) return this;
    const entries = [...this.#entries.values()].flatMap((entry) => {
      let touched = false;
      changes.iterChangedRanges((from, to) => {
        if (from < entry.to && to > entry.from) touched = true;
      });
      return touched
        ? []
        : [{ ...entry, from: changes.mapPos(entry.from, 1), to: changes.mapPos(entry.to, -1) }];
    });
    return new LivePreviewEntrances(sourcePath, entries);
  }

  stateFor(from: number, to: number, documentId: string): PresentationEntranceState {
    const existing = this.#entries.get(from);
    if (existing?.to === to && existing.documentId === documentId) return existing.state;
    const retained = existing !== undefined || this.#entries.size < MARKDOWN_EMBED_LIMITS.matches;
    const state = { presented: !retained };
    if (retained) this.#entries.set(from, { documentId, from, to, state });
    return state;
  }
}
