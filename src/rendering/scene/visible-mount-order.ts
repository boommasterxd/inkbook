import type { RenderBand } from "../../domain/commands/render-bands";
import type { MountSlice, MountYieldReason } from "./mount-slice";
import type { MountedSceneElement } from "./mounted-element";
import type { MutableSceneInstrumentation } from "./types";
import type { VisibilityResult } from "./visibility-state";

interface BandOrder {
  readonly positions: Map<string, number>;
  readonly tree: Uint32Array;
  index: number;
}

/** A bounded visibility-local successor index avoids scans through unmounted rank gaps. */
export class VisibleMountOrder {
  readonly #bands: Record<RenderBand, BandOrder>;
  readonly #previous: Partial<Record<RenderBand, MountedSceneElement>> = {};
  #requiresOrderReview = false;

  public constructor(
    private readonly visibility: VisibilityResult,
    private readonly mounted: ReadonlyMap<string, MountedSceneElement>,
    private readonly instrumentation: MutableSceneInstrumentation,
    private readonly epoch: number,
  ) {
    this.#bands = {
      content: {
        positions: new Map(),
        tree: new Uint32Array(visibility.content.count + 1),
        index: 0,
      },
      highlight: {
        positions: new Map(),
        tree: new Uint32Array(visibility.highlight.count + 1),
        index: 0,
      },
    };
  }

  public get requiresOrderReview(): boolean {
    return this.#requiresOrderReview;
  }

  public memoryUsage(): number {
    return (
      this.#bands.content.tree.byteLength +
      this.#bands.highlight.tree.byteLength +
      (this.#bands.content.positions.size + this.#bands.highlight.positions.size) * 48
    );
  }

  public build(slice: MountSlice): MountYieldReason | undefined {
    for (const band of ["highlight", "content"] as const) {
      const order = this.#bands[band];
      const visible = this.visibility[band];
      while (order.index < visible.count) {
        const reason = slice.blockingReason();
        if (reason !== undefined) return reason;
        const index = order.index++;
        const id = visible.ids[index];
        this.instrumentation.visibilityReconcileVisits += 1;
        slice.record();
        if (id === undefined) continue;
        order.positions.set(id, index);
        const entry = this.mounted.get(id);
        if (entry === undefined) continue;
        const previous = this.#previous[band];
        this.#requiresOrderReview ||=
          entry.band !== band ||
          entry.detachedPathCount > 0 ||
          entry.committedOrderEpoch !== this.epoch ||
          (previous !== undefined && previous.committedRank >= entry.committedRank);
        this.#previous[band] = entry;
        if (entry.detachedPathCount === 0) this.addPosition(order, index);
      }
    }
    return undefined;
  }

  public add(id: string): void {
    const entry = this.mounted.get(id);
    if (entry === undefined) return;
    const order = this.#bands[entry.band];
    const index = order.positions.get(id);
    if (index !== undefined) this.addPosition(order, index);
  }

  public successor(id: string, band: RenderBand): MountedSceneElement | undefined {
    const order = this.#bands[band];
    const position = order.positions.get(id);
    if (position === undefined) return undefined;
    return this.successorAfter(position, band);
  }

  public addPublished(band: RenderBand, position: number): void {
    this.addPosition(this.#bands[band], position);
  }

  public successorAfter(position: number, band: RenderBand): MountedSceneElement | undefined {
    const order = this.#bands[band];
    const before = this.prefix(order.tree, position + 1);
    const total = this.prefix(order.tree, order.tree.length - 1);
    if (before >= total) return undefined;
    const index = this.positionFor(order.tree, before + 1);
    const successor = this.visibility[band].ids[index];
    return successor === undefined ? undefined : this.mounted.get(successor);
  }

  private addPosition(order: BandOrder, position: number): void {
    for (let index = position + 1; index < order.tree.length; index += index & -index)
      order.tree[index] = order.tree[index]! + 1;
  }

  private prefix(tree: Uint32Array, end: number): number {
    let count = 0;
    for (let index = end; index > 0; index -= index & -index) count += tree[index]!;
    return count;
  }

  private positionFor(tree: Uint32Array, ordinal: number): number {
    let index = 0;
    let step = 2 ** Math.floor(Math.log2(tree.length));
    let remaining = ordinal;
    while (step > 0) {
      const next = index + step;
      if (next < tree.length && tree[next]! < remaining) {
        index = next;
        remaining -= tree[next]!;
      }
      step = Math.floor(step / 2);
    }
    return index;
  }
}
