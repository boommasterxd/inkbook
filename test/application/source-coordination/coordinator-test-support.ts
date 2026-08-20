import {
  createHostTransactionSequence,
  createSessionOrder,
  createSidecarRevision,
  createSourceGeneration,
  parseSha256Digest,
  parseSourceCheckpointId,
  parseViewId,
  type CommandResultV1,
} from "../../../src/application/note-session";
import type { SidecarBaseIdentityV1 } from "../../../src/application/recovery";
import {
  createMarkdownSourceCoordinator,
  type MarkdownSourceCoordinatorOptionsV1,
  type MarkdownSourceCoordinatorV1,
} from "../../../src/application/source-coordination/coordinator";
import type {
  MarkdownSourceTransitionV1,
  SourceCheckpointOperationV1,
  SourceSnapshotV1,
} from "../../../src/application/source-coordination/types";
import type {
  SourceDigestWorkPortV1,
  SourceMapWorkPortV1,
} from "../../../src/application/source-coordination/work-ports";
import {
  ControlledSourceScheduler,
  ImmediateSourceDigestWorkPort,
  ImmediateSourceMapWorkPort,
  TestStreamingDigestPort,
  digestUtf8,
} from "./support";

const DIGEST_HEX_LENGTH = 64;
const IDENTIFIER_PAYLOAD_LENGTH = 26;

interface PendingAppend {
  readonly checkpoint: SourceCheckpointOperationV1;
  readonly reject: (error: unknown) => void;
  readonly resolve: (result: CommandResultV1<void>) => void;
}

class ControlledRecoveryStore {
  readonly pending: PendingAppend[] = [];
  readonly checkpoints: SourceCheckpointOperationV1[] = [];

  appendSourceCheckpoint(
    checkpoint: SourceCheckpointOperationV1,
  ): Promise<CommandResultV1<void>> {
    this.checkpoints.push(checkpoint);
    return new Promise((resolve, reject) => {
      this.pending.push({ checkpoint, reject, resolve });
    });
  }

  acknowledgeNext(result: CommandResultV1<void>): void {
    const next = this.pending.shift();
    if (next === undefined) throw new Error("No checkpoint append is pending.");
    next.resolve(result);
  }

  rejectNext(error: unknown): void {
    const next = this.pending.shift();
    if (next === undefined) throw new Error("No checkpoint append is pending.");
    next.reject(error);
  }
}

export interface CoordinatorFixture {
  readonly coordinator: MarkdownSourceCoordinatorV1;
  readonly durableSnapshots: SourceSnapshotV1[];
  readonly mapWork: SourceMapWorkPortV1;
  readonly recovery: ControlledRecoveryStore;
  readonly saves: number[];
  readonly scheduler: ControlledSourceScheduler;
  setBase(base: SidecarBaseIdentityV1): void;
}

interface FixturePorts {
  readonly digest?: SourceDigestWorkPortV1;
  readonly map?: SourceMapWorkPortV1;
}

export async function createCoordinatorFixture(
  ports: FixturePorts = {},
): Promise<CoordinatorFixture> {
  const scheduler = new ControlledSourceScheduler();
  const recovery = new ControlledRecoveryStore();
  const saves: number[] = [];
  const durableSnapshots: SourceSnapshotV1[] = [];
  const mapWork = ports.map ?? new ImmediateSourceMapWorkPort();
  let checkpointIndex = 0;
  let sessionOrder = 0;
  let base: SidecarBaseIdentityV1 = Object.freeze({
    markdownPath: "notes/source.md",
    rawTextSha256: parseSha256Digest("a".repeat(DIGEST_HEX_LENGTH)),
    revision: createSidecarRevision(1),
    vaultRelativePath: "notes/source.inkbook.json",
  });
  const options: MarkdownSourceCoordinatorOptionsV1 = {
    createCheckpointId: () => {
      checkpointIndex += 1;
      return parseSourceCheckpointId(
        `scp_${String(checkpointIndex).padStart(IDENTIFIER_PAYLOAD_LENGTH, "0")}`,
      );
    },
    digestPort: new TestStreamingDigestPort(),
    initialDigest: digestUtf8("abc"),
    initialGeneration: createSourceGeneration(1),
    initialMarkdown: "abc",
    nextSessionOrder: () => {
      sessionOrder += 1;
      return createSessionOrder(sessionOrder);
    },
    onDurableCheckpoint: (_checkpoint, snapshot) =>
      durableSnapshots.push(snapshot),
    onSaveGeneration: (generation) => saves.push(generation),
    readBase: () => base,
    recoveryStore: recovery,
    scheduler,
    sourceDigestWorkPort: ports.digest ?? new ImmediateSourceDigestWorkPort(),
    sourceMapWorkPort: mapWork,
  };
  const result = await createMarkdownSourceCoordinator(options);
  if (!result.ok) throw new Error("Expected a valid source coordinator.");
  return {
    coordinator: result.value,
    durableSnapshots,
    mapWork,
    recovery,
    saves,
    scheduler,
    setBase: (replacement): void => {
      base = replacement;
    },
  };
}

export function insertionTransition(
  view: "pane-a" | "pane-b",
  sequence: number,
  prior: string,
  replacement: string,
): MarkdownSourceTransitionV1 {
  const insertionOffset = replacement.length - prior.length;
  return {
    hostTransactionSequence: createHostTransactionSequence(sequence),
    offsetMap: {
      spans: [
        {
          newFromUtf16: 1,
          newToUtf16: 1 + insertionOffset,
          oldFromUtf16: 1,
          oldToUtf16: 1,
        },
      ],
    },
    ownedMetadataChange: false,
    priorDigest: digestUtf8(prior),
    priorGeneration: createSourceGeneration(sequence),
    replacementMarkdown: replacement,
    viewId: parseViewId(view),
  };
}
