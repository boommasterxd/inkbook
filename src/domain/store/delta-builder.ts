import { DELTA_DOMAINS, type DeltaDomain, type ElementRecord, type StoreDelta } from "./types";

interface PendingDelta {
  after: ElementRecord | null;
  before: ElementRecord | null;
  domains: number;
}

const DOMAIN_BITS: Readonly<Record<DeltaDomain, number>> = Object.freeze({
  connection: 1 << 3,
  geometry: 1 << 0,
  order: 1 << 2,
  paint: 1 << 1,
  visibility: 1 << 4,
});
const ORDER_DOMAINS: readonly DeltaDomain[] = Object.freeze(["order"]);

export class DeltaBuilder {
  readonly #changes = new Map<string, PendingDelta>();
  readonly #dirtyBands = { content: false, highlight: false };

  public add(
    id: string,
    before: ElementRecord | null,
    after: ElementRecord | null,
    domains: readonly DeltaDomain[],
  ): void {
    this.merge(id, before, after, domainMask(domains));
  }

  public addOrder(id: string, record: ElementRecord): void {
    this.merge(id, record, record, DOMAIN_BITS.order);
  }

  private merge(
    id: string,
    before: ElementRecord | null,
    after: ElementRecord | null,
    domains: number,
  ): void {
    const current = this.#changes.get(id);
    if (current === undefined) {
      this.#changes.set(id, { after, before, domains });
      return;
    }
    current.after = after;
    if (current.before === null) current.before = before;
    current.domains |= domains;
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
        domains:
          change.domains === DOMAIN_BITS.order
            ? ORDER_DOMAINS
            : Object.freeze(
                DELTA_DOMAINS.filter((domain) => (change.domains & DOMAIN_BITS[domain]) !== 0),
              ),
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

function domainMask(domains: readonly DeltaDomain[]): number {
  let mask = 0;
  for (const domain of domains) mask |= DOMAIN_BITS[domain];
  return mask;
}
