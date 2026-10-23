import { renderBandOf, type RenderBand } from "../../commands/render-bands";
import type { InkElementV1 } from "../../schema/public";
import { MutationPreparationScheduler } from "./mutation-preparation-scheduler";
import { createUnchangedMutationOrder, type MutationOrder } from "./mutation-order";
import { prepareInsertionElementSteps } from "./prepared-insertion-element";
import type { ElementMutation, ElementRecord, StoreSliceScheduler } from "../types";

interface AppendSource {
  readonly bands: Readonly<Record<RenderBand, readonly string[]>>;
  readonly records: ReadonlyMap<string, ElementRecord>;
}

/** Private Store producer: new IDs and bands come only from immutable validated elements. */
export async function prepareAppendMutation(
  source: AppendSource,
  requested: readonly InkElementV1[],
  scheduler: StoreSliceScheduler,
): Promise<
  { readonly mutation: ElementMutation; readonly order: MutationOrder } | "cancelled" | null
> {
  const work = new MutationPreparationScheduler(scheduler);
  const elements: InkElementV1[] = [];
  const inserted: Record<RenderBand, string[]> = { content: [], highlight: [] };
  const ids = new Set<string>();
  for (const input of requested) {
    if (!(work.checkpoint() || (await work.resume()))) return "cancelled";
    const pending = work.run(prepareInsertionElementSteps(input));
    const element = pending instanceof Promise ? await pending : pending;
    if (element === "cancelled") return element;
    if (source.records.has(element.id) || ids.has(element.id))
      throw new RangeError("Append requires unique new element IDs.");
    ids.add(element.id);
    elements.push(element);
    inserted[renderBandOf(element)].push(element.id);
  }
  if (elements.length === 0) return null;
  const order = createUnchangedMutationOrder(source.bands);
  const { bands, ranks, dirtyBands } = order;
  for (const band of ["highlight", "content"] as const) {
    if (inserted[band].length === 0) continue;
    const next: string[] = [];
    for (const id of source.bands[band]) {
      if (!(work.checkpoint() || (await work.resume()))) return "cancelled";
      next.push(id);
    }
    for (const id of inserted[band]) {
      if (!(work.checkpoint() || (await work.resume()))) return "cancelled";
      ranks.set(id, { band, rank: next.length });
      next.push(id);
    }
    bands[band] = next;
    dirtyBands[band] = true;
  }
  if (scheduler.isCancelled?.()) return "cancelled";
  return {
    mutation: { bands, elements: Object.freeze(elements) },
    order,
  };
}
