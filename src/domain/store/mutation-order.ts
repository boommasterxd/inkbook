import { renderBandOf, type RenderBand } from "../commands/render-bands";
import type { MutationPreparationScheduler } from "./mutation-preparation-scheduler";
import type { ElementMutation, ElementRank, ElementRecord } from "./types";
import type { OwnedMutationHistory, OwnedMutationReplay } from "./owned-mutation-history";
import { validateTrustedRemovalOrder } from "./trusted-removal-order";

export interface MutationOrder {
  readonly bands: Record<RenderBand, string[]>;
  readonly ranks: Map<string, ElementRank>;
  readonly dirtyBands: Record<RenderBand, boolean>;
  readonly relativeOrderPreserved: Readonly<Record<RenderBand, boolean>>;
}

interface OrderSource {
  readonly bands: Readonly<Record<RenderBand, readonly string[]>>;
  readonly records: ReadonlyMap<string, ElementRecord>;
}

export async function prepareMutationOrder(
  source: OrderSource,
  requested: ElementMutation,
  records: ReadonlyMap<string, ElementRecord | null>,
  sourceRanks: ReadonlyMap<string, ElementRank>,
  scheduler: MutationPreparationScheduler,
  proof: Readonly<{
    trustedRemoval: boolean;
    ownedReplay?: OwnedMutationReplay | undefined;
    ownedRecords?: ReadonlyMap<string, ElementRecord> | undefined;
    removeIds: ReadonlySet<string>;
    trustedOrder?: MutationOrder | undefined;
  }>,
): Promise<MutationOrder | "cancelled"> {
  if (proof.trustedOrder !== undefined) return proof.trustedOrder;
  if (proof.trustedRemoval) {
    return validateTrustedRemovalOrder(requested, source, sourceRanks, proof.removeIds, scheduler);
  }
  const replayOrder = await prepareReplayOrder(
    source,
    requested,
    records,
    sourceRanks,
    scheduler,
    proof,
  );
  if (replayOrder !== undefined) return replayOrder;
  return validateMutationBands(requested.bands, source, records, sourceRanks, scheduler);
}

async function prepareReplayOrder(
  source: OrderSource,
  requested: ElementMutation,
  records: ReadonlyMap<string, ElementRecord | null>,
  sourceRanks: ReadonlyMap<string, ElementRank>,
  scheduler: MutationPreparationScheduler,
  proof: Parameters<typeof prepareMutationOrder>[5],
): Promise<MutationOrder | "cancelled" | undefined> {
  if (proof.ownedReplay === undefined || proof.ownedRecords === undefined) return undefined;
  const { bandsTrusted, retainedMutation } = proof.ownedReplay;
  if (!bandsTrusted) return undefined;
  // Private canonical membership is proved by the desired-connection producer.
  // Public replay retains its complete resulting-record check.
  if (retainedMutation === undefined) {
    const valid = await validateOwnedReplayMembership(
      source,
      records,
      proof.ownedRecords,
      scheduler,
    );
    if (valid === "cancelled") return valid;
    if (!valid) return undefined;
  }
  return restoreOwnedReplayBands(
    requested.bands,
    source,
    sourceRanks,
    proof.ownedReplay.history,
    scheduler,
  );
}

export async function validateMutationBands(
  requested: Readonly<Record<RenderBand, readonly string[]>>,
  source: OrderSource,
  records: ReadonlyMap<string, ElementRecord | null>,
  sourceRanks: ReadonlyMap<string, ElementRank>,
  scheduler: MutationPreparationScheduler,
): Promise<MutationOrder | "cancelled"> {
  const seen = new Set<string>();
  const ranks = new Map<string, ElementRank>();
  const dirtyBands = {
    content: requested.content.length !== source.bands.content.length,
    highlight: requested.highlight.length !== source.bands.highlight.length,
  };
  const relativeOrderPreserved = { content: true, highlight: true };
  let resultingSize = source.records.size;
  for (const [id, record] of records) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    if (record === null) resultingSize -= 1;
    else if (!source.records.has(id)) resultingSize += 1;
  }
  const bands: Record<RenderBand, string[]> = { content: [], highlight: [] };
  const state = {
    requested,
    source,
    records,
    sourceRanks,
    seen,
    ranks,
    bands,
    dirtyBands,
    relativeOrderPreserved,
  };
  for (const band of ["highlight", "content"] as const) {
    if ((await collectValidatedBand(state, band, scheduler)) === "cancelled") return "cancelled";
  }
  if (seen.size !== resultingSize) {
    throw new RangeError("Mutation band order must contain each resulting element exactly once.");
  }
  return { bands, ranks, dirtyBands, relativeOrderPreserved };
}

interface BandValidationState {
  readonly requested: Readonly<Record<RenderBand, readonly string[]>>;
  readonly source: OrderSource;
  readonly records: ReadonlyMap<string, ElementRecord | null>;
  readonly sourceRanks: ReadonlyMap<string, ElementRank>;
  readonly seen: Set<string>;
  readonly ranks: Map<string, ElementRank>;
  readonly bands: Record<RenderBand, string[]>;
  readonly dirtyBands: Record<RenderBand, boolean>;
  readonly relativeOrderPreserved: Record<RenderBand, boolean>;
}

async function collectValidatedBand(
  state: BandValidationState,
  band: RenderBand,
  scheduler: MutationPreparationScheduler,
): Promise<void | "cancelled"> {
  let previousSurvivorRank = -1;
  for (let index = 0; index < state.requested[band].length; index += 1) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    const id = state.requested[band][index]!;
    const record = state.records.has(id) ? state.records.get(id) : state.source.records.get(id);
    if (record == null || renderBandOf(record.element) !== band || state.seen.has(id)) {
      throw new RangeError("Mutation band order must contain each resulting element exactly once.");
    }
    state.seen.add(id);
    state.bands[band].push(id);
    if (state.source.bands[band][index] !== id) state.dirtyBands[band] = true;
    const prior = state.sourceRanks.get(id);
    if (prior !== undefined && prior.band === band) {
      if (prior.rank <= previousSurvivorRank) state.relativeOrderPreserved[band] = false;
      previousSurvivorRank = prior.rank;
    }
    if (prior?.band !== band || prior.rank !== index) state.ranks.set(id, { band, rank: index });
  }
  state.dirtyBands[band] ||= state.bands[band].length !== state.source.bands[band].length;
}

export function mutationOrderPreserved(
  order: MutationOrder,
  sourceRanks: ReadonlyMap<string, ElementRank>,
  id: string,
): boolean {
  const rank = order.ranks.get(id) ?? sourceRanks.get(id);
  return rank !== undefined && order.relativeOrderPreserved[rank.band];
}

export function* mutationAffectedIds(
  records: ReadonlyMap<string, ElementRecord | null>,
  order: MutationOrder,
): Generator<string | null> {
  yield* records.keys();
  if (!order.relativeOrderPreserved.content || !order.relativeOrderPreserved.highlight) {
    for (const [id, rank] of order.ranks) {
      // Retain a checkpoint slot for duplicates and unaffected ranks as well.
      yield !order.relativeOrderPreserved[rank.band] && !records.has(id) ? id : null;
    }
  }
}

export async function validateOwnedReplayMembership(
  source: OrderSource,
  records: ReadonlyMap<string, ElementRecord | null>,
  expected: ReadonlyMap<string, ElementRecord>,
  scheduler: MutationPreparationScheduler,
): Promise<boolean | "cancelled"> {
  for (const [id, record] of expected) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    const next = records.has(id) ? records.get(id) : source.records.get(id);
    if (next?.element !== record.element) return false;
  }
  for (const [id, record] of records) {
    if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
    if (record !== null && record.element !== expected.get(id)?.element) return false;
    if (record === null && expected.has(id)) return false;
  }
  return true;
}

export async function restoreOwnedReplayBands(
  requested: Readonly<Record<RenderBand, readonly string[]>>,
  source: OrderSource,
  sourceRanks: ReadonlyMap<string, ElementRank>,
  owned: OwnedMutationHistory,
  scheduler: MutationPreparationScheduler,
): Promise<MutationOrder | "cancelled"> {
  const bands: Record<RenderBand, string[]> = { content: [], highlight: [] };
  const ranks = new Map<string, ElementRank>();
  for (const band of ["highlight", "content"] as const) {
    if (!owned.dirtyBands[band]) {
      // Only the private mutation-version proof admits reuse of these mutable
      // authoritative arrays. Frozen history arrays are never installed here.
      bands[band] = source.bands[band] as string[];
      continue;
    }
    for (let rank = 0; rank < requested[band].length; rank += 1) {
      if (!(scheduler.checkpoint() || (await scheduler.resume()))) return "cancelled";
      const id = requested[band][rank]!;
      bands[band].push(id);
      const prior = sourceRanks.get(id);
      if (prior?.band !== band || prior.rank !== rank) ranks.set(id, { band, rank });
    }
  }
  return {
    bands,
    ranks,
    dirtyBands: { ...owned.dirtyBands },
    relativeOrderPreserved: owned.relativeOrderPreserved,
  };
}
