import { commandFailure, commandSuccess } from "../note-session/results";
import type {
  CommandResultV1,
  SourceGeneration,
  Sha256Digest,
} from "../note-session/types";
import type { SidecarBaseIdentityV1 } from "../recovery/base";
import type { RecoveryStore } from "../recovery/port";
import { sameSidecarBase } from "../recovery/validation";
import { validateSourceOffsetMap } from "./offset-map";
import type { SourceCheckpointOperationV1 } from "./types";
import { SOURCE_COORDINATION_LIMITS_V1 } from "./limits";
import type { SourceMapGraphNodeV1 } from "./map-graph";
import type { SourceOffsetMapIdentityV1 } from "./types";

export type SourceCheckpointTimerHandleV1 = object | number;

export interface SourceCheckpointSchedulerV1 {
  cancel(handle: SourceCheckpointTimerHandleV1): void;
  now(): number;
  schedule(
    delayMs: number,
    callback: () => void,
  ): SourceCheckpointTimerHandleV1;
}

export interface PendingSourceCheckpointV1 {
  readonly mapIdentity: SourceOffsetMapIdentityV1;
  readonly prior: SourceMapGraphNodeV1;
  readonly replacement: SourceMapGraphNodeV1;
}

export interface AdmittedSourceTransitionV1 {
  readonly mapDigest: Sha256Digest;
  readonly mapIdentity: SourceOffsetMapIdentityV1;
  readonly node: SourceMapGraphNodeV1;
  readonly priorDigest: Sha256Digest;
  readonly priorGeneration: SourceGeneration;
}

export interface ActiveSourceCheckpointV1 extends PendingSourceCheckpointV1 {
  readonly checkpoint: SourceCheckpointOperationV1;
  readonly token: number;
}

export interface SourceBarrierWaiterV1 {
  readonly generation: SourceGeneration;
  readonly resolve: (result: CommandResultV1<SourceMapGraphNodeV1>) => void;
}

export interface ForcedSourceBarrierV1 {
  readonly completion: Promise<CommandResultV1<SourceMapGraphNodeV1>>;
  readonly generation: SourceGeneration;
}

export async function appendSourceCheckpointFailClosed(
  recoveryStore: Pick<RecoveryStore, "appendSourceCheckpoint">,
  checkpoint: SourceCheckpointOperationV1,
): Promise<CommandResultV1<void>> {
  try {
    return await recoveryStore.appendSourceCheckpoint(checkpoint);
  } catch {
    return commandFailure("recovery-unavailable");
  }
}

export interface SourceCheckpointRootV1 {
  readonly generation: SourceGeneration;
  readonly digest: Sha256Digest;
  readonly utf16Length: number;
  readonly base: SidecarBaseIdentityV1;
}

export interface SourceRecoveryTargetV1 {
  readonly digest: Sha256Digest;
  readonly utf16Length: number;
}

type SourceRecoverySuccessorIndexV1 = ReadonlyMap<
  string,
  SourceCheckpointOperationV1 | null
>;

export function validateSourceCheckpointChain(
  root: SourceCheckpointRootV1,
  checkpoints: readonly SourceCheckpointOperationV1[],
): CommandResultV1<readonly SourceCheckpointOperationV1[]> {
  let generation = root.generation;
  let digest = root.digest;
  let length = root.utf16Length;
  let priorOrder = 0;
  const checkpointIds = new Set<string>();
  const validatedCheckpoints: SourceCheckpointOperationV1[] = [];
  for (const checkpoint of checkpoints) {
    if (
      checkpointIds.has(checkpoint.checkpointId) ||
      checkpoint.sessionOrder <= priorOrder ||
      checkpoint.priorGeneration !== generation ||
      checkpoint.priorDigest !== digest ||
      checkpoint.priorUtf16Length !== length ||
      checkpoint.replacementGeneration !== generation + 1 ||
      !sameSidecarBase(checkpoint.base, root.base)
    ) {
      return commandFailure("recovery-unavailable");
    }
    const map = validateSourceOffsetMap(
      checkpoint.offsetMap,
      checkpoint.priorUtf16Length,
      checkpoint.replacementUtf16Length,
    );
    if (!map.ok) return commandFailure("recovery-unavailable");
    checkpointIds.add(checkpoint.checkpointId);
    validatedCheckpoints.push(
      Object.freeze({
        ...checkpoint,
        base: Object.freeze({ ...checkpoint.base }),
        offsetMap: map.value,
      }),
    );
    priorOrder = checkpoint.sessionOrder;
    generation = checkpoint.replacementGeneration;
    digest = checkpoint.replacementDigest;
    length = checkpoint.replacementUtf16Length;
  }
  return commandSuccess(Object.freeze(validatedCheckpoints));
}

export function recoverSourceCheckpointChain(
  root: SourceCheckpointRootV1,
  checkpoints: readonly SourceCheckpointOperationV1[],
  target: SourceRecoveryTargetV1,
): CommandResultV1<readonly SourceCheckpointOperationV1[]> {
  if (
    checkpoints.length > SOURCE_COORDINATION_LIMITS_V1.maxChangedSpans ||
    !isValidRoot(root) ||
    !Number.isSafeInteger(target.utf16Length) ||
    target.utf16Length < 0
  ) {
    return commandFailure("recovery-unavailable");
  }
  if (
    target.digest === root.digest &&
    target.utf16Length === root.utf16Length
  ) {
    return commandSuccess(Object.freeze([]));
  }
  const successors = indexRecoverySuccessors(root, checkpoints);
  if (!successors.ok) return successors;
  const recovered: SourceCheckpointOperationV1[] = [];
  let generation = root.generation;
  let digest = root.digest;
  let utf16Length = root.utf16Length;
  let priorOrder = 0;
  while (recovered.length < checkpoints.length) {
    const next = successors.value.get(
      sourceRecoveryKey(generation, digest, utf16Length),
    );
    if (
      next === undefined ||
      next === null ||
      next.sessionOrder <= priorOrder ||
      !isValidSuccessor(next)
    ) {
      return commandFailure("recovery-unavailable");
    }
    recovered.push(next);
    priorOrder = next.sessionOrder;
    generation = next.replacementGeneration;
    digest = next.replacementDigest;
    utf16Length = next.replacementUtf16Length;
    if (digest === target.digest && utf16Length === target.utf16Length) {
      return commandSuccess(Object.freeze(recovered));
    }
  }
  return commandFailure("recovery-unavailable");
}

function indexRecoverySuccessors(
  root: SourceCheckpointRootV1,
  checkpoints: readonly SourceCheckpointOperationV1[],
): CommandResultV1<SourceRecoverySuccessorIndexV1> {
  const checkpointIds = new Set<string>();
  const successors = new Map<string, SourceCheckpointOperationV1 | null>();
  for (const checkpoint of checkpoints) {
    if (
      checkpointIds.has(checkpoint.checkpointId) ||
      !sameSidecarBase(checkpoint.base, root.base)
    ) {
      return commandFailure("recovery-unavailable");
    }
    checkpointIds.add(checkpoint.checkpointId);
    const key = sourceRecoveryKey(
      checkpoint.priorGeneration,
      checkpoint.priorDigest,
      checkpoint.priorUtf16Length,
    );
    successors.set(key, successors.has(key) ? null : checkpoint);
  }
  return commandSuccess(successors);
}

function sourceRecoveryKey(
  generation: SourceGeneration,
  digest: Sha256Digest,
  utf16Length: number,
): string {
  return `${String(generation)}:${digest}:${String(utf16Length)}`;
}

function isValidRoot(root: SourceCheckpointRootV1): boolean {
  return (
    Number.isSafeInteger(root.generation) &&
    root.generation > 0 &&
    Number.isSafeInteger(root.utf16Length) &&
    root.utf16Length >= 0
  );
}

function isValidSuccessor(checkpoint: SourceCheckpointOperationV1): boolean {
  if (checkpoint.replacementGeneration !== checkpoint.priorGeneration + 1) {
    return false;
  }
  return validateSourceOffsetMap(
    checkpoint.offsetMap,
    checkpoint.priorUtf16Length,
    checkpoint.replacementUtf16Length,
  ).ok;
}
