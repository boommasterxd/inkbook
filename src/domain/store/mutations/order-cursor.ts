import type { RenderBand } from "../../commands/render-bands";

export interface StoreOrderStep {
  readonly id?: string;
  readonly done: boolean;
  readonly stale: boolean;
}

/** Reads the authoritative band order lazily without retaining an order snapshot. */
export class StoreOrderCursor {
  #band = 0;
  #index = 0;
  #cancelled = false;
  readonly #version: number;

  public constructor(
    private readonly bands: () => Readonly<Record<RenderBand, readonly string[]>>,
    private readonly version: () => number,
  ) {
    this.#version = version();
  }

  public advance(): StoreOrderStep {
    if (this.#cancelled || this.version() !== this.#version) return { done: true, stale: true };
    while (this.#band < 2) {
      const band = this.#band === 0 ? "highlight" : "content";
      const id = this.bands()[band][this.#index++];
      if (id !== undefined) return { id, done: false, stale: false };
      this.#band += 1;
      this.#index = 0;
    }
    return { done: true, stale: false };
  }

  public cancel(): void {
    this.#cancelled = true;
  }

  public memoryUsage(): number {
    return this.#cancelled ? 0 : 128;
  }
}
