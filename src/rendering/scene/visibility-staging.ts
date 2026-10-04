import type { RenderBand } from "../../domain/commands/render-bands";
import type { MountedSceneElement } from "./mounted-element";
import type { MountSlice, MountYieldReason } from "./mount-slice";
import type {
  PendingReconciliation,
  SceneVisibilityReconcilerOptions,
} from "./reconciliation-state";
import type { PreviewTransform } from "./scene-mount-preparation";
import type { SceneElementRecord } from "./types";
import { stageVisibilityDelta } from "./visibility-delta-reconciliation";
import type { PendingMutationRun } from "./visibility-publication";
import { collectPendingVisibilityExits } from "./visibility-reconciliation-commit";
import { SceneEntrantPriority, type SceneVisibilityPriority } from "./scene-entrant-priority";
import { VisibleMountOrder } from "./visible-mount-order";
import type { VisibilityDelta, VisibilityResult } from "./visibility-state";

/** Only an existing membership delta carries a reusable retained SVG order proof. */
export function canRetargetVisibilityDelta(
  pending: PendingReconciliation | undefined,
  progressive: boolean,
  cancelled: boolean,
  options: SceneVisibilityReconcilerOptions,
  delta: VisibilityDelta | undefined,
): boolean {
  return (
    progressive &&
    (pending === undefined || (pending.delta !== undefined && pending.delta.order === undefined)) &&
    !cancelled &&
    options.orderDirty.content.size === 0 &&
    options.orderDirty.highlight.size === 0 &&
    delta !== undefined
  );
}

export function createProgressiveVisibilityDelta(
  visibility: VisibilityResult,
  delta: VisibilityDelta | undefined,
  options: SceneVisibilityReconcilerOptions,
  priority: SceneVisibilityPriority | undefined,
  epoch: number,
  previous?: PendingReconciliation["delta"],
): NonNullable<PendingReconciliation["delta"]> {
  const retained = previous?.priority;
  if (retained !== undefined && delta !== undefined)
    retained.retarget(delta.entered, delta.exited, priority);
  return {
    phase: "warm",
    ids: [],
    index: 0,
    deferred: [],
    successors: {},
    search: undefined,
    priority:
      retained ??
      new SceneEntrantPriority(
        entrantIds(visibility, delta === undefined ? undefined : [...delta.entered]),
        options.store,
        { has: (id) => options.mounted.has(id) || !options.visibility.contains(id) },
        options.instrumentation,
        priority,
      ),
    ...(delta === undefined
      ? {
          order: new VisibleMountOrder(visibility, options.mounted, options.instrumentation, epoch),
        }
      : {}),
  };
}

function* entrantIds(visibility: VisibilityResult, entered?: readonly string[]): Generator<string> {
  if (entered !== undefined) {
    yield* entered;
    return;
  }
  for (const band of ["highlight", "content"] as const) {
    const visible = visibility[band];
    for (let index = 0; index < visible.count; index += 1) {
      const id = visible.ids[index];
      if (id !== undefined) yield id;
    }
  }
}

export function stageVisibilityBands(
  pending: PendingReconciliation,
  deadline: number,
  now: () => number,
  options: {
    readonly finish: () => void;
    readonly entry: (id: string | undefined) => MountYieldReason | undefined;
  },
): MountYieldReason | undefined {
  let visited = 0;
  while (true) {
    const visible = pending.visibility[pending.cursor.band];
    while (pending.cursor.index >= 0) {
      if (visited > 0 && now() >= deadline) return "deadline";
      visited += 1;
      const id = visible.ids[pending.cursor.index--];
      const reason = options.entry(id);
      if (reason !== undefined) {
        pending.cursor.index += 1;
        return reason;
      }
    }
    options.finish();
    if (pending.cursor.band === "content") return undefined;
    pending.cursor.band = "content";
    pending.cursor.index = pending.visibility.content.count - 1;
    pending.cursor.successor = undefined;
  }
}

interface VisibilityStagingOptions extends SceneVisibilityReconcilerOptions {
  readonly pendingId: () => string | undefined;
  readonly waiting: () => boolean;
  readonly promoted: () => MountYieldReason | undefined;
  readonly bands: () => MountYieldReason | undefined;
  readonly stage: (
    record: SceneElementRecord,
    allowLocal: boolean,
  ) => MountedSceneElement | undefined;
  readonly run: (
    band: RenderBand,
    successor: MountedSceneElement | undefined,
  ) => PendingMutationRun;
  readonly exit: (id: string) => void;
}

/** New target entrants receive the shared budget before old exit bookkeeping. */
export function stageVisibilitySlice(
  pending: PendingReconciliation,
  slice: MountSlice,
  previews: ReadonlyMap<string, PreviewTransform>,
  options: VisibilityStagingOptions,
): MountYieldReason | undefined {
  const order = pending.delta?.order;
  const building = order?.build(slice);
  if (building !== undefined) return building;
  if (order?.requiresOrderReview) {
    delete pending.delta;
  }
  let reason = options.promoted();
  if (reason === undefined) reason = slice.blockingReason();
  reason ??=
    pending.delta === undefined
      ? options.bands()
      : stageVisibilityDelta(pending, slice, previews, {
          ...options,
          prepareDeferred: () => {
            const id = options.pendingId();
            const record = id === undefined ? undefined : options.store.get(id);
            return record !== undefined && options.stage(record, true) !== undefined
              ? record.id
              : undefined;
          },
          stage: (_pending, record) => options.stage(record, false),
        });
  if (reason !== undefined || !pending.scanExits) return reason;
  return collectPendingVisibilityExits(pending, slice, options.instrumentation, options.exit);
}
