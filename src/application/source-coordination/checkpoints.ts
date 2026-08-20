import { commandFailure, commandSuccess } from "../note-session/results";
import type {
  CommandResultV1,
  SourceGeneration,
  Sha256Digest,
} from "../note-session/types";
import type { SidecarBaseIdentityV1 } from "../recovery/base";
import { sameSidecarBase } from "../recovery/validation";
import { validateSourceOffsetMap } from "./offset-map";
import type { SourceCheckpointOperationV1 } from "./types";

export interface SourceCheckpointRootV1 {
  readonly generation: SourceGeneration;
  readonly digest: Sha256Digest;
  readonly utf16Length: number;
  readonly base: SidecarBaseIdentityV1;
}

export function validateSourceCheckpointChain(
  root: SourceCheckpointRootV1,
  checkpoints: readonly SourceCheckpointOperationV1[],
): CommandResultV1<readonly SourceCheckpointOperationV1[]> {
  let generation = root.generation;
  let digest = root.digest;
  let length = root.utf16Length;
  let priorOrder = 0;
  const checkpointIds = new Set<string>();
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
    priorOrder = checkpoint.sessionOrder;
    generation = checkpoint.replacementGeneration;
    digest = checkpoint.replacementDigest;
    length = checkpoint.replacementUtf16Length;
  }
  return commandSuccess(Object.freeze([...checkpoints]));
}
