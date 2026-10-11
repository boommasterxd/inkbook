import { createRetainedRecordPayload } from "./owned-mutation-history";
import type { ElementRecord, ElementReplacementHistoryData, ImmutableInkElement } from "./types";

export interface ReplacementHistoryBuilder {
  append(before: ElementRecord, after: ElementRecord): void;
  finish(): ElementReplacementHistoryData;
}

/** Retained element identities resolve only within the owning Store's private registry. */
export class ReplacementHistory {
  readonly #records = new WeakMap<ImmutableInkElement, ElementRecord>();

  public retainedRecord(element: ImmutableInkElement): ElementRecord | undefined {
    return this.#records.get(element);
  }

  public createBuilder(): ReplacementHistoryBuilder {
    const previous: ImmutableInkElement[] = [];
    const replacements: ImmutableInkElement[] = [];
    const payload = createRetainedRecordPayload();
    return {
      append: (before, after) => {
        if (before === after) return;
        this.#records.set(before.element, before);
        this.#records.set(after.element, after);
        previous.push(before.element);
        replacements.push(after.element);
        payload.add(before);
        payload.add(after);
      },
      finish: () =>
        Object.freeze({
          previous: Object.freeze(previous),
          replacements: Object.freeze(replacements),
          payloadBytes: payload.bytes,
        }),
    };
  }
}
