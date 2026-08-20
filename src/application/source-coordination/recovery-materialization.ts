import { validateAnnotationPatchV1 } from "../../domain/operations";
import type { AnnotationPatchV1 } from "../../domain/operations";
import { commandFailure, commandSuccess } from "../note-session/results";
import type {
  CommandResultV1,
  SessionOrder,
  SourceGeneration,
  Sha256Digest,
} from "../note-session/types";
import { sameSidecarBase } from "../recovery/validation";
import type {
  HostRecordedDirectionAttemptV1,
  HostRecordedForwardAttemptV1,
  RecoveryAttemptV1,
} from "../recovery/types";
import {
  recoverSourceCheckpointChain,
  validateSourceCheckpointChain,
  type SourceRecoveryTargetV1,
} from "./checkpoints";
import { SOURCE_COORDINATION_LIMITS_V1 } from "./limits";
import type { SourceCheckpointOperationV1, SourceOffsetMapV1 } from "./types";
import type { SourceCheckpointRootV1 } from "./checkpoints";

const LAST_INDEX_OFFSET = 1;

export interface RecoveryPatchMaterializationWorkV1 {
  readonly checkpoint: SourceCheckpointOperationV1;
  readonly offsetMap: SourceOffsetMapV1;
  readonly patch: AnnotationPatchV1;
  readonly role: "forward" | "inverse" | "direction";
  readonly traversedNodes: number;
}

type RecoveryPatchMaterializerV1 = (
  work: RecoveryPatchMaterializationWorkV1,
) => CommandResultV1<AnnotationPatchV1>;

type MaterializedRecoveryAttemptV1 =
  HostRecordedForwardAttemptV1 | HostRecordedDirectionAttemptV1;

export interface MaterializedRecoveryReplayV1 {
  readonly attempt: MaterializedRecoveryAttemptV1;
  readonly sourceDigest: Sha256Digest;
  readonly sourceGeneration: SourceGeneration;
  readonly traversedNodes: number;
  readonly utf16Length: number;
}

export interface RecoveryHistoryMaterializationRequestV1 {
  readonly attempts: readonly RecoveryAttemptV1[];
  readonly checkpoints: readonly SourceCheckpointOperationV1[];
  readonly materializePatch: RecoveryPatchMaterializerV1;
  readonly root: SourceCheckpointRootV1;
  readonly target: SourceRecoveryTargetV1;
}

interface SourceNodeV1 {
  readonly digest: Sha256Digest;
  readonly generation: SourceGeneration;
  readonly reachedAtOrder: number;
  readonly suffixIndex: number;
  readonly utf16Length: number;
}

export function materializeRecoveryHistory(
  request: RecoveryHistoryMaterializationRequestV1,
): CommandResultV1<readonly MaterializedRecoveryReplayV1[]> {
  const recovered = recoverSourceCheckpointChain(
    request.root,
    request.checkpoints,
    request.target,
  );
  if (!recovered.ok) return commandFailure("recovery-unavailable");
  const chain = validateSourceCheckpointChain(request.root, recovered.value);
  if (!chain.ok || !hasUniqueTotalOrder(request.attempts, chain.value)) {
    return commandFailure("recovery-unavailable");
  }
  const nodes = indexSourceNodes(request.root, chain.value);
  if (!nodes.ok) return nodes;
  const orderedAttempts = [...request.attempts].sort(compareSessionOrder);
  const replay: MaterializedRecoveryReplayV1[] = [];
  for (const attempt of orderedAttempts) {
    const node = nodes.value.get(
      sourceNodeKey(
        attempt.expectedSourceGeneration,
        attempt.expectedSourceDigest,
      ),
    );
    if (!isSafeAttemptPosition(attempt, node, chain.value, request.root)) {
      return commandFailure("recovery-unavailable");
    }
    if (attempt.kind === "prepared-forward") continue;
    const suffix = chain.value.slice(node.suffixIndex);
    const materialized = materializeAttempt(
      attempt,
      suffix,
      request.materializePatch,
    );
    if (!materialized.ok) return materialized;
    const finalNode = finalSourceNode(request.root, chain.value);
    replay.push(
      Object.freeze({
        attempt: materialized.value,
        sourceDigest: finalNode.digest,
        sourceGeneration: finalNode.generation,
        traversedNodes: suffix.length,
        utf16Length: finalNode.utf16Length,
      }),
    );
  }
  return commandSuccess(Object.freeze(replay));
}

function materializeAttempt(
  attempt: MaterializedRecoveryAttemptV1,
  suffix: readonly SourceCheckpointOperationV1[],
  materializePatch: RecoveryPatchMaterializerV1,
): CommandResultV1<MaterializedRecoveryAttemptV1> {
  if (suffix.length > SOURCE_COORDINATION_LIMITS_V1.maxHistoryMappingNodes) {
    return commandFailure("recovery-unavailable");
  }
  if (attempt.kind === "host-recorded-forward") {
    const forward = materializePatchThroughSuffix(
      attempt.forward,
      "forward",
      suffix,
      materializePatch,
    );
    if (!forward.ok) return forward;
    const inverse = materializePatchThroughSuffix(
      attempt.inverse,
      "inverse",
      suffix,
      materializePatch,
    );
    if (!inverse.ok) return inverse;
    return commandSuccess(
      Object.freeze({
        ...attempt,
        acknowledgement: Object.freeze({ ...attempt.acknowledgement }),
        base: Object.freeze({ ...attempt.base }),
        forward: forward.value,
        inverse: inverse.value,
      }),
    );
  }
  const direction = materializePatchThroughSuffix(
    attempt.directionPatch,
    "direction",
    suffix,
    materializePatch,
  );
  if (!direction.ok) return direction;
  return commandSuccess(
    Object.freeze({
      ...attempt,
      acknowledgement: Object.freeze({ ...attempt.acknowledgement }),
      base: Object.freeze({ ...attempt.base }),
      directionPatch: direction.value,
    }),
  );
}

function materializePatchThroughSuffix(
  initialPatch: AnnotationPatchV1,
  role: RecoveryPatchMaterializationWorkV1["role"],
  suffix: readonly SourceCheckpointOperationV1[],
  materializePatch: RecoveryPatchMaterializerV1,
): CommandResultV1<AnnotationPatchV1> {
  const initial = validateAnnotationPatchV1(initialPatch);
  if (!initial.ok) return commandFailure("recovery-unavailable");
  let patch = initial.value;
  for (let index = 0; index < suffix.length; index += 1) {
    const checkpoint = suffix[index];
    if (checkpoint === undefined) {
      return commandFailure("recovery-unavailable");
    }
    const result = materializePatch(
      Object.freeze({
        checkpoint,
        offsetMap: checkpoint.offsetMap,
        patch,
        role,
        traversedNodes: index + 1,
      }),
    );
    if (!result.ok) return commandFailure("recovery-unavailable");
    const validated = validateAnnotationPatchV1(result.value);
    if (!validated.ok) return commandFailure("recovery-unavailable");
    patch = validated.value;
  }
  return commandSuccess(patch);
}

function indexSourceNodes(
  root: SourceCheckpointRootV1,
  checkpoints: readonly SourceCheckpointOperationV1[],
): CommandResultV1<ReadonlyMap<string, SourceNodeV1 | null>> {
  const nodes = new Map<string, SourceNodeV1 | null>();
  addSourceNode(nodes, {
    digest: root.digest,
    generation: root.generation,
    reachedAtOrder: 0,
    suffixIndex: 0,
    utf16Length: root.utf16Length,
  });
  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index];
    if (checkpoint === undefined) {
      return commandFailure("recovery-unavailable");
    }
    addSourceNode(nodes, {
      digest: checkpoint.replacementDigest,
      generation: checkpoint.replacementGeneration,
      reachedAtOrder: checkpoint.sessionOrder,
      suffixIndex: index + 1,
      utf16Length: checkpoint.replacementUtf16Length,
    });
  }
  return commandSuccess(nodes);
}

function addSourceNode(
  nodes: Map<string, SourceNodeV1 | null>,
  node: SourceNodeV1,
): void {
  const key = sourceNodeKey(node.generation, node.digest);
  nodes.set(key, nodes.has(key) ? null : Object.freeze(node));
}

function isSafeAttemptPosition(
  attempt: RecoveryAttemptV1,
  node: SourceNodeV1 | null | undefined,
  checkpoints: readonly SourceCheckpointOperationV1[],
  root: SourceCheckpointRootV1,
): node is SourceNodeV1 {
  if (
    node === undefined ||
    node === null ||
    node.reachedAtOrder >= attempt.sessionOrder ||
    !sameSidecarBase(attempt.base, root.base)
  ) {
    return false;
  }
  const nextCheckpoint = checkpoints[node.suffixIndex];
  return (
    nextCheckpoint === undefined ||
    attempt.sessionOrder < nextCheckpoint.sessionOrder
  );
}

function hasUniqueTotalOrder(
  attempts: readonly RecoveryAttemptV1[],
  checkpoints: readonly SourceCheckpointOperationV1[],
): boolean {
  const orders = new Set<number>();
  const records: readonly { readonly sessionOrder: SessionOrder }[] = [
    ...attempts,
    ...checkpoints,
  ];
  for (const record of records) {
    if (
      !Number.isSafeInteger(record.sessionOrder) ||
      record.sessionOrder <= 0 ||
      orders.has(record.sessionOrder)
    ) {
      return false;
    }
    orders.add(record.sessionOrder);
  }
  return true;
}

function compareSessionOrder(
  left: RecoveryAttemptV1,
  right: RecoveryAttemptV1,
): number {
  return left.sessionOrder - right.sessionOrder;
}

function finalSourceNode(
  root: SourceCheckpointRootV1,
  checkpoints: readonly SourceCheckpointOperationV1[],
): Pick<SourceNodeV1, "digest" | "generation" | "utf16Length"> {
  const last = checkpoints[checkpoints.length - LAST_INDEX_OFFSET];
  return last === undefined
    ? root
    : {
        digest: last.replacementDigest,
        generation: last.replacementGeneration,
        utf16Length: last.replacementUtf16Length,
      };
}

function sourceNodeKey(
  generation: SourceGeneration,
  digest: Sha256Digest,
): string {
  return `${String(generation)}:${digest}`;
}
