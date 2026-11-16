import type { InkElementV1 } from "../../schema/public";
import type {
  DeltaDomain,
  ElementRecord,
  ImmutableInkElement,
  StoreDelta,
  StoreSliceScheduler,
} from "../types";
import { MutationPreparationScheduler } from "../mutations/mutation-preparation-scheduler";

const lockSources = new WeakMap<InkElementV1, ImmutableInkElement>();

export class LockedElementMutationError extends RangeError {
  public constructor() {
    super("Locked elements cannot be changed.");
    this.name = "LockedElementMutationError";
  }
}

/** Reuse immutable geometry and resources for a store-owned interaction-only replacement. */
export function withElementLock(element: ImmutableInkElement, locked: boolean): InkElementV1 {
  const { locked: _previous, ...fields } = element;
  const replacement = Object.freeze({ ...fields, ...(locked ? { locked: true } : {}) });
  lockSources.set(replacement as InkElementV1, element);
  return replacement as InkElementV1;
}

export function isElementLockReplacement(
  source: ImmutableInkElement,
  replacement: InkElementV1,
): boolean {
  return lockSources.get(replacement) === source;
}

export function elementLockCandidate(
  current: ElementRecord,
  element: InkElementV1,
  retainedRecord: ElementRecord | undefined,
): {
  readonly current: ElementRecord;
  readonly element: InkElementV1;
  readonly retainedRecord: ElementRecord | undefined;
  readonly owned: true;
  readonly domains: readonly DeltaDomain[];
} | null {
  return (current.element.locked === true) === (element.locked === true)
    ? null
    : { current, element, retainedRecord, owned: true, domains: Object.freeze(["interaction"]) };
}

export function assertElementUnlocked(element: Pick<InkElementV1, "locked">): void {
  if (element.locked === true) throw new LockedElementMutationError();
}

/** Rank changes caused by editable neighbors do not mutate the locked record itself. */
export function* assertUnlockedDeltaSteps(delta: StoreDelta): Generator<void, void> {
  for (const change of delta.changes) {
    if (change.before !== null && change.before !== change.after) {
      assertElementUnlocked(change.before.element);
    }
    yield;
  }
}

export async function protectElementDelta(
  delta: StoreDelta,
  scheduler: StoreSliceScheduler,
  historyReplay = false,
): Promise<boolean> {
  if (historyReplay || scheduler.protectLocked !== true) return true;
  const pending = new MutationPreparationScheduler(scheduler).run(assertUnlockedDeltaSteps(delta));
  const result = pending instanceof Promise ? await pending : pending;
  return result !== "cancelled" && !(scheduler.isCancelled?.() ?? false);
}
