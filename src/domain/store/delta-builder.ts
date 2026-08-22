import { DELTA_DOMAINS, type DeltaDomain, type ElementRecord, type StoreDelta } from "./types";

interface PendingDelta {
  after: ElementRecord | null;
  before: ElementRecord | null;
  readonly domains: Set<DeltaDomain>;
}

export class DeltaBuilder {
  readonly #changes = new Map<string, PendingDelta>();
  readonly #dirtyBands = { content: false, highlight: false };

  public add(
    id: string,
    before: ElementRecord | null,
    after: ElementRecord | null,
    domains: readonly DeltaDomain[],
  ): void {
    const current = this.#changes.get(id);
    if (current === undefined) {
      this.#changes.set(id, { after, before, domains: new Set(domains) });
      return;
    }
    current.after = after;
    if (current.before === null) current.before = before;
    for (const domain of domains) current.domains.add(domain);
  }

  public dirtyBand(band: "content" | "highlight"): void {
    this.#dirtyBands[band] = true;
  }

  public build(geometryVersion: number, paintVersion: number): StoreDelta | null {
    if (this.#changes.size === 0) return null;
    const changes = [...this.#changes].map(([id, change]) =>
      Object.freeze({
        after: change.after,
        before: change.before,
        domains: Object.freeze(DELTA_DOMAINS.filter((domain) => change.domains.has(domain))),
        id,
      }),
    );
    return Object.freeze({
      changes: Object.freeze(changes),
      dirtyBands: Object.freeze({ ...this.#dirtyBands }),
      geometryVersion,
      paintVersion,
    });
  }
}
