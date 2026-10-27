import type { RenderBand } from "../../../domain/commands/render-bands";
import type { StoreOrderCursor } from "../../../domain/store/mutations/order-cursor";
import type { MountedSceneElement } from "../content/mounted-element";
import type { SceneStorePort } from "../types";

export const PREVIEW_SNAPSHOT_PATH_LIMIT = 256;
export interface SelectionRankRun {
  readonly band: RenderBand;
  readonly entries: MountedSceneElement[];
  readonly firstRank: number;
  lastRank: number;
}
export interface SelectionRunPlan {
  readonly selection: ReadonlySet<string>;
  readonly groups: readonly SelectionRankRun[];
  readonly exceptions: readonly MountedSceneElement[];
  readonly exceptionIds: readonly string[];
  readonly snapshots: readonly string[];
  readonly members: ReadonlyMap<string, MountedSceneElement>;
  readonly ids: readonly string[];
  readonly legacyTransformSurfaces: number;
  readonly residualTransformSurfaces: number;
  readonly sharedTransformSurfaces: number;
}

const PLAN_METADATA_BYTES = 128;
const MEMBER_BYTES = 48;
const REFERENCE_BYTES = 8;
const RANK_RUN_BYTES = 64;

/** Owned bookkeeping estimate; mounted records and ID strings remain borrowed. */
export function selectionRunPlanMemoryUsage(
  plan: SelectionRunPlan | undefined,
  groupsOwnEntries = false,
): number {
  if (plan === undefined) return 0;
  const references =
    plan.ids.length +
    plan.groups.length +
    plan.exceptions.length +
    plan.exceptionIds.length +
    plan.snapshots.length +
    (groupsOwnEntries ? 0 : plan.members.size - plan.exceptions.length);
  return (
    PLAN_METADATA_BYTES +
    plan.members.size * MEMBER_BYTES +
    references * REFERENCE_BYTES +
    plan.groups.length * RANK_RUN_BYTES
  );
}

/** Uses the existing versioned authoritative order cursor, not another rank index. */
export class SelectionRunPlanning {
  readonly #cursor: StoreOrderCursor | undefined;
  readonly #runs: SelectionRankRun[] = [];
  readonly #members = new Map<string, MountedSceneElement>();
  readonly #ids: string[] = [];
  readonly #exceptions: MountedSceneElement[] = [];
  readonly #exceptionIds: string[] = [];
  readonly #snapshots: string[] = [];
  #groups: readonly SelectionRankRun[] = [];
  #runEntries = 0;
  #surfaceSnapshots: ReadonlySet<string> | undefined;
  readonly #steps: Generator<void, SelectionRunPlan | undefined>;
  #current: SelectionRankRun | undefined;
  #unselected = true;
  #invalid = false;
  #result: SelectionRunPlan | undefined;
  #done = false;
  public constructor(
    private readonly selection: ReadonlySet<string>,
    private readonly store: SceneStorePort,
    private readonly mounted: ReadonlyMap<string, MountedSceneElement>,
    private readonly surfaceCost: (entry: MountedSceneElement) => number = (entry) =>
      entry.group === null ? entry.paths.length : 1,
  ) {
    this.#cursor = selection.size > PREVIEW_SNAPSHOT_PATH_LIMIT ? store.beginOrder?.() : undefined;
    this.#steps = this.plan();
  }
  public get done(): boolean {
    return this.#done;
  }
  public get result(): SelectionRunPlan | undefined {
    return this.#result;
  }
  public valid(): boolean {
    return this.#done && this.#cursor !== undefined && !this.#cursor.advance().stale;
  }
  public step(): boolean {
    if (this.#done) return true;
    const next = this.#steps.next();
    if (next.done) {
      this.#done = true;
      this.#result = next.value;
      this.#runs.length = 0;
      this.#runEntries = 0;
      this.#current = undefined;
    }
    return this.#done;
  }
  public cancel(): void {
    this.#cursor?.cancel();
    this.#steps.return(undefined);
    this.#done = true;
    this.#result = undefined;
    this.#surfaceSnapshots = undefined;
  }
  public memoryUsage(groupsOwnEntries = false): number {
    if (this.#result !== undefined)
      return selectionRunPlanMemoryUsage(this.#result, groupsOwnEntries);
    return (
      PLAN_METADATA_BYTES +
      this.#members.size * MEMBER_BYTES +
      (this.#ids.length +
        this.#runEntries +
        this.#runs.length +
        this.#groups.length +
        this.#exceptions.length +
        this.#exceptionIds.length +
        this.#snapshots.length) *
        REFERENCE_BYTES +
      this.#runs.length * RANK_RUN_BYTES +
      (this.#surfaceSnapshots?.size ?? 0) * 40
    );
  }
  private *readMembers(cursor: StoreOrderCursor): Generator<void, boolean> {
    while (true) {
      const next = cursor.advance();
      if (next.stale) return false;
      if (next.done) break;
      if (next.id === undefined) continue;
      if (!this.selection.has(next.id)) {
        this.#unselected = true;
        yield;
        continue;
      }
      const record = this.store.get(next.id),
        entry = this.mounted.get(next.id);
      if (
        record === undefined ||
        entry === undefined ||
        entry.geometryVersion !== record.geometryVersion ||
        !canonicalRunMember(entry)
      ) {
        this.#invalid = true;
        yield;
        continue;
      }
      if (this.#unselected || this.#current?.band !== record.band) {
        this.#current = {
          band: record.band,
          entries: [],
          firstRank: record.rank,
          lastRank: record.rank,
        };
        this.#runs.push(this.#current);
      }
      this.#current.entries.push(entry);
      this.#runEntries += 1;
      this.#current.lastRank = record.rank;
      this.#unselected = false;
      this.#members.set(entry.id, entry);
      this.#ids.push(entry.id);
      yield;
    }
    return true;
  }
  private *measureSurfaces(
    groups: readonly SelectionRankRun[],
    snapshots: readonly string[],
  ): Generator<void, { legacyTransformSurfaces: number; residualTransformSurfaces: number }> {
    const snapshotMembers = new Set(snapshots);
    this.#surfaceSnapshots = snapshotMembers;
    let legacyTransformSurfaces = 0;
    let residualTransformSurfaces = 0;
    for (const run of groups) {
      for (const entry of run.entries) {
        const surfaces = this.surfaceCost(entry);
        if (snapshotMembers.has(entry.id)) residualTransformSurfaces += surfaces;
        else legacyTransformSurfaces += surfaces;
        yield;
      }
    }
    this.#surfaceSnapshots = undefined;
    return { legacyTransformSurfaces, residualTransformSurfaces };
  }
  private *admitSnapshots(
    ids: readonly string[],
    exceptions: readonly MountedSceneElement[],
  ): Generator<void, boolean> {
    for (const id of ids) {
      const entry = this.#members.get(id)!;
      if (!exceptions.includes(entry) && requiresSingularFill(entry)) return false;
      yield;
    }
    return true;
  }
  *plan(): Generator<void, SelectionRunPlan | undefined> {
    if (this.#cursor === undefined || this.selection.size === 0) return undefined;
    if (!(yield* this.readMembers(this.#cursor))) return undefined;
    if (this.#invalid || this.#members.size !== this.selection.size) return undefined;
    const largest: Partial<Record<RenderBand, SelectionRankRun>> = {};
    for (const run of this.#runs) {
      if (run.entries.length > (largest[run.band]?.entries.length ?? 0)) largest[run.band] = run;
      yield;
    }
    const groups = (this.#groups = Object.values(largest)),
      exceptions = this.#exceptions,
      exceptionIds = this.#exceptionIds,
      snapshots = this.#snapshots;
    let paths = 0;
    for (const run of this.#runs) {
      if (groups.includes(run)) {
        yield;
        continue;
      }
      for (const entry of run.entries) {
        paths += snapshotCost(entry);
        if (paths > PREVIEW_SNAPSHOT_PATH_LIMIT) return undefined;
        exceptions.push(entry);
        exceptionIds.push(entry.id);
        snapshots.push(entry.id);
        yield;
      }
    }
    for (const run of groups) {
      for (const entry of run.entries) {
        const cost = snapshotCost(entry);
        if (paths + cost > PREVIEW_SNAPSHOT_PATH_LIMIT) break;
        snapshots.push(entry.id);
        paths += cost;
        yield;
      }
    }
    // Canonical singular fills need an additional retained surface. Until its complete
    // lifetime is reserved, keep the whole cohort on the existing preview path.
    if (!(yield* this.admitSnapshots(snapshots, exceptions))) return undefined;
    const { legacyTransformSurfaces, residualTransformSurfaces } = yield* this.measureSurfaces(
      groups,
      snapshots,
    );
    // One ink parent per band and the existing single shared trace parent.
    const sharedTransformSurfaces = groups.length + 1;
    if (legacyTransformSurfaces <= residualTransformSurfaces + sharedTransformSurfaces)
      return undefined;
    return {
      selection: this.selection,
      groups,
      exceptions,
      exceptionIds,
      snapshots,
      members: this.#members,
      ids: this.#ids,
      legacyTransformSurfaces,
      residualTransformSurfaces,
      sharedTransformSurfaces,
    };
  }
}
export function canonicalRunMember(entry: MountedSceneElement): boolean {
  return (
    entry.displayedPathParts === entry.pathParts &&
    entry.appliedPreviewTransform === null &&
    !entry.motionActive &&
    !entry.fadeActive
  );
}
function snapshotCost(entry: MountedSceneElement): number {
  const element = entry.displayedElement;
  return element.kind === "arrow"
    ? 1 +
        Number(["triangle", "diamond", "circle"].includes(element.startNode)) +
        Number(["triangle", "diamond", "circle"].includes(element.endNode))
    : 1;
}
function requiresSingularFill(entry: MountedSceneElement): boolean {
  const element = entry.displayedElement;
  return (
    (element.kind === "stroke" && element.style.pressureEnabled) ||
    (element.kind === "arrow" &&
      [element.startNode, element.endNode].some((node) =>
        ["triangle", "diamond", "circle"].includes(node),
      ))
  );
}
