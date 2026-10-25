import type { InkElementV1 } from "../../../domain/schema/public";

export interface ConnectedPreviewRequest {
  readonly ids: readonly string[];
  readonly materialize: (id: string) => InkElementV1 | undefined;
}

export type ProgressivePreviewPurpose = "connected" | ConnectedPreviewRequest;

/** Prepares mounted connection membership through the owning scene's shared admission. */
export class ConnectedPreviewCohort {
  #source: readonly string[] | undefined;
  #members = new Set<string>();
  #sourceCursor = 0;
  #mounted: readonly string[] = [];
  #memberBytes = 0;
  #preparationBytes = 0;
  #generation = 0;

  public *select(
    ids: readonly string[],
    mounted: () => Iterable<string>,
  ): Generator<void, readonly string[]> {
    const generation = ++this.#generation;
    try {
      if (this.#source !== ids) {
        this.#source = ids;
        this.#members = new Set();
        this.#sourceCursor = 0;
        this.#memberBytes = ids.length * 8;
      }
      while (this.#sourceCursor < ids.length) {
        if (generation !== this.#generation) return [];
        const id = ids[this.#sourceCursor++]!;
        if (!this.#members.has(id)) {
          this.#members.add(id);
          this.#memberBytes += 32 + id.length * 2;
        }
        yield;
      }
      const selected: string[] = [];
      for (const id of mounted()) {
        if (generation !== this.#generation) return [];
        if (this.#members.has(id)) {
          selected.push(id);
        }
        this.#preparationBytes = selected.length * 8;
        yield;
      }
      if (generation !== this.#generation) return [];
      this.#mounted = selected;
      return selected;
    } finally {
      if (generation === this.#generation) this.#preparationBytes = 0;
    }
  }

  public includes(id: string): boolean {
    return this.#members.has(id);
  }

  public materializer(
    connected: ConnectedPreviewRequest,
  ): (id: string) => InkElementV1 | undefined {
    return (id) => {
      const element = connected.materialize(id);
      if (element === undefined) return undefined;
      return element.kind === "line" || element.kind === "arrow" ? element : undefined;
    };
  }

  public memoryUsage(): number {
    return this.#memberBytes + this.#preparationBytes + this.#mounted.length * 8;
  }

  public clear(): void {
    this.#generation += 1;
    this.#source = undefined;
    this.#sourceCursor = 0;
    this.#members.clear();
    this.#mounted = [];
    this.#memberBytes = 0;
    this.#preparationBytes = 0;
  }
}
