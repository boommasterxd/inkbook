import { preserveTextReflowOrigin } from "../../../domain/geometry/text-reflow";
import type { InkElementV1, TextElementV2 } from "../../../domain/schema/public";

export interface TextReflowOptions {
  readonly preservePadding?: boolean;
}

export type TextReflow = (
  element: TextElementV2,
  signal: AbortSignal,
  options?: TextReflowOptions,
) => Promise<TextElementV2>;

export function createTextReflowSession(
  element: InkElementV1 | undefined,
  reflow: TextReflow | undefined,
  sideResize: boolean,
  onReady: () => void,
): TextReflowSession | undefined {
  return element?.kind === "text" && reflow !== undefined && sideResize
    ? new TextReflowSession(element, reflow, onReady)
    : undefined;
}

/** Owns one in-flight layout operation and one latest width request for a field resize. */
export class TextReflowSession {
  readonly #reflow: TextReflow;
  readonly #onReady: () => void;
  readonly #initial: TextElementV2;
  #requested: TextElementV2;
  #prepared: TextElementV2;
  #operation: Promise<void> | undefined;
  #abort: AbortController | undefined;
  #failed = false;
  #disposed = false;
  #generation = 0;
  #completed = 0;

  public constructor(element: TextElementV2, reflow: TextReflow, onReady: () => void) {
    this.#requested = element;
    this.#prepared = element;
    this.#initial = element;
    this.#reflow = reflow;
    this.#onReady = onReady;
  }

  public get current(): TextElementV2 {
    return this.#prepared;
  }

  public restore(): void {
    this.request(this.#initial);
  }

  public preview() {
    return {
      exactElements: [this.#prepared],
      exactPreviewTruncated: true,
      previewFrame: null,
      snapCandidate: null,
      snapGuide: null,
      transform: null,
    };
  }

  public request(element: TextElementV2): void {
    if (this.#disposed || sameFieldGeometry(element, this.#requested)) return;
    this.#requested = element;
    this.#generation += 1;
    if (sameFieldGeometry(element, this.#initial)) {
      this.#abort?.abort();
      this.#prepared = this.#initial;
      this.#completed = this.#generation;
      this.#failed = false;
      return;
    }
    this.#schedule();
  }

  public async settle(): Promise<TextElementV2 | null> {
    while (this.#operation !== undefined) await this.#operation;
    return this.#disposed || this.#failed ? null : this.#prepared;
  }

  public dispose(): void {
    this.#disposed = true;
    this.#abort?.abort();
  }

  #schedule(): void {
    this.#operation ??= this.#run().finally(() => {
      this.#operation = undefined;
      if (!this.#disposed && this.#completed !== this.#generation) this.#schedule();
    });
  }

  async #run(): Promise<void> {
    while (!this.#disposed && this.#completed !== this.#generation) {
      const generation = this.#generation;
      const requested = this.#requested;
      const abort = new AbortController();
      this.#abort = abort;
      try {
        const prepared = await this.#reflow(requested, abort.signal);
        if (
          this.#disposed ||
          abort.signal.aborted ||
          !sameFieldGeometry(requested, this.#requested)
        )
          continue;
        this.#prepared = alignReflowedText(this.#requested, prepared);
        this.#failed = false;
        this.#completed = this.#generation;
        this.#onReady();
      } catch {
        if (this.#disposed || abort.signal.aborted || generation !== this.#generation) continue;
        this.#failed = true;
        this.#completed = generation;
      }
    }
  }
}

function sameFieldGeometry(left: TextElementV2, right: TextElementV2): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.rotation === right.rotation
  );
}

export function alignReflowedText(
  requested: TextElementV2,
  prepared: TextElementV2,
): TextElementV2 {
  if (
    requested.id !== prepared.id ||
    requested.source !== prepared.source ||
    requested.width !== prepared.width
  )
    throw new RangeError("Text reflow must preserve field identity, source and requested width.");
  return preserveTextReflowOrigin(requested, prepared);
}
