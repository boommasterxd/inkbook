import {
  HostHistoryCoordinatorV1,
  type ActionableHistoryEntrySnapshotV1,
  type HostHistoryRecoveryContextV1,
  type HostHistorySnapshotV1,
} from "../../application/host-history";
import {
  createRandomOperationIdV1,
  createRandomRecoveryAttemptIdV1,
  type NoteIdentityV1,
  type RecoveryAttemptId,
  type SessionOrder,
  type Sha256Digest,
  type SourceGeneration,
} from "../../application/note-session";
import type {
  RecoveryStore,
  SidecarBaseIdentityV1,
} from "../../application/recovery";
import type { RuntimeSceneStateV1 } from "../../domain/scene";

export interface RuntimeHistoryRecoveryIdentityV1 {
  readonly base: SidecarBaseIdentityV1;
  readonly identity: NoteIdentityV1;
  readonly sourceDigest: Sha256Digest;
  readonly sourceGeneration: SourceGeneration;
}

export function createRuntimeHistoryCoordinatorV1(input: {
  readonly identity: NoteIdentityV1;
  readonly initialScene: RuntimeSceneStateV1;
  readonly nextSessionOrder: () => SessionOrder;
  readonly onPreparedAttempt?: (attemptId: RecoveryAttemptId) => void;
  readonly onRelease?: (entry: ActionableHistoryEntrySnapshotV1) => void;
  readonly readIdentity: () => RuntimeHistoryRecoveryIdentityV1;
  readonly recovery: RecoveryStore;
  readonly restoreSnapshot?: HostHistorySnapshotV1;
}): HostHistoryCoordinatorV1 {
  return new HostHistoryCoordinatorV1(
    {
      createOperationId: () => createRandomOperationIdV1(),
      initialScene: input.initialScene,
      noteIdentity: input.identity,
      recovery: input.recovery,
      recoveryContext: (): HostHistoryRecoveryContextV1 => {
        const current = input.readIdentity();
        return {
          base: current.base,
          createRecoveryAttemptId: (): RecoveryAttemptId => {
            const attemptId = createRandomRecoveryAttemptIdV1();
            input.onPreparedAttempt?.(attemptId);
            return attemptId;
          },
          expectedSourceDigest: current.sourceDigest,
          expectedSourceGeneration: current.sourceGeneration,
          nextSessionOrder: input.nextSessionOrder,
        };
      },
      ...(input.onRelease === undefined ? {} : { onRelease: input.onRelease }),
    },
    input.restoreSnapshot === undefined
      ? { hostEffectsMayBeReachable: true }
      : {
          hostEffectsMayBeReachable: true,
          snapshot: input.restoreSnapshot,
        },
  );
}
