import type { InkElementV1 } from "../../../domain/schema/public";
import { elementRenderBand, type RenderBand } from "./element-fragments";
import { codecFailure } from "../codec-failure";
import type { DocumentCodecResult } from "../types";

interface OrderPreparation {
  readonly currentElements: ReadonlyMap<string, InkElementV1>;
  readonly currentOrders: Readonly<Record<RenderBand, string[]>>;
  readonly changed: ReadonlyMap<string, InkElementV1>;
  readonly removed: ReadonlySet<string>;
  readonly orderChanges?: Readonly<Partial<Record<RenderBand, readonly string[]>>>;
}

/** Current orders are already authoritative; every affected band is proved completely. */
export function* prepareSerializationOrdersSteps(
  source: OrderPreparation,
  nodesPerStep: number,
): Generator<void, DocumentCodecResult<Record<RenderBand, string[]>>> {
  const membership = yield* prepareBandMembership(source, nodesPerStep);
  const orders = { ...source.currentOrders };
  for (const band of ["highlight", "content"] as const) {
    const replacement = source.orderChanges?.[band];
    if (!membership.affected[band] && replacement === undefined) continue;
    const prepared = yield* prepareBandOrder(
      { source, band, replacement, expectedSize: membership.sizes[band] },
      nodesPerStep,
    );
    if (!prepared.ok) return prepared;
    orders[band] = prepared.value;
  }
  return {
    ok: true,
    value:
      orders.highlight === source.currentOrders.highlight &&
      orders.content === source.currentOrders.content
        ? source.currentOrders
        : orders,
  };
}

function* prepareBandMembership(
  source: OrderPreparation,
  nodesPerStep: number,
): Generator<void, { sizes: Record<RenderBand, number>; affected: Record<RenderBand, boolean> }> {
  const sizes = {
    highlight: source.currentOrders.highlight.length,
    content: source.currentOrders.content.length,
  };
  const affected = { highlight: false, content: false };
  let visited = 0;
  for (const id of source.removed) {
    const current = source.currentElements.get(id);
    if (current !== undefined) {
      const band = elementRenderBand(current);
      sizes[band] -= 1;
      affected[band] = true;
    }
    if (++visited % nodesPerStep === 0) yield;
  }
  for (const element of source.changed.values()) {
    const current = source.currentElements.get(element.id);
    const band = elementRenderBand(element);
    const previous = current === undefined ? undefined : elementRenderBand(current);
    if (previous !== band) {
      if (previous !== undefined) {
        sizes[previous] -= 1;
        affected[previous] = true;
      }
      sizes[band] += 1;
      affected[band] = true;
    }
    if (++visited % nodesPerStep === 0) yield;
  }
  return { sizes, affected };
}

interface BandPreparation {
  readonly source: OrderPreparation;
  readonly band: RenderBand;
  readonly replacement: readonly string[] | undefined;
  readonly expectedSize: number;
}

function* prepareBandOrder(
  { source, band, replacement, expectedSize }: BandPreparation,
  nodesPerStep: number,
): Generator<void, DocumentCodecResult<string[]>> {
  const current = source.currentOrders[band];
  const seen = new Set<string>();
  const candidate: string[] = [];
  let unchanged = true;
  let visited = 0;
  for (const id of replacement ?? current) {
    if (++visited % nodesPerStep === 0) yield;
    if (replacement === undefined && source.removed.has(id)) continue;
    const element = source.removed.has(id)
      ? undefined
      : (source.changed.get(id) ?? source.currentElements.get(id));
    if (element === undefined || elementRenderBand(element) !== band || seen.has(id))
      return invalidOrder();
    seen.add(id);
    unchanged &&= current[candidate.length] === id;
    candidate.push(id);
  }
  // Unique valid IDs in this band, at its exact projected size, prove completeness.
  if (candidate.length !== expectedSize) return invalidOrder();
  unchanged &&= candidate.length === current.length;
  return { ok: true, value: unchanged ? current : candidate };
}

function invalidOrder(): DocumentCodecResult<never> {
  return codecFailure(
    "invalid-order",
    "Band order must contain every current element ID exactly once.",
  );
}
