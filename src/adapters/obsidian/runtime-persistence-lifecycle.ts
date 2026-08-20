import type { NoteSessionSnapshotV1 } from "../../application/note-session";
import type { ActiveRemovalRecoveryV1 } from "../../application/recovery";
import {
  openRuntimePersistenceV1,
  runtimeOpenSnapshotV1,
  type RuntimePersistenceOpenResultV1,
} from "./runtime-persistence-open";
import type { SidecarMarkerWriter } from "./vault-sidecar/marker";
import type { VaultSidecarRepository } from "./vault-sidecar/repository";
import type { RuntimePersistenceConfigV1 } from "./runtime-session";

type UsableRuntimePersistenceOpenResultV1 = Extract<
  RuntimePersistenceOpenResultV1,
  { readonly kind: "existing" | "unannotated" | "removal-pending" }
>;

export interface RuntimePersistenceLifecycleStateV1 {
  readonly addCheckpoint: (
    checkpointId: import("../../application/note-session").SourceCheckpointId,
  ) => void;
  readonly addAttempt: (
    attemptId: import("../../application/note-session").RecoveryAttemptId,
  ) => void;
  readonly createSource: (
    opened: UsableRuntimePersistenceOpenResultV1,
  ) => Promise<void>;
  readonly createSavePipeline: () => void;
  readonly hasSource: () => boolean;
  readonly initializeHistory: (
    opened: UsableRuntimePersistenceOpenResultV1,
  ) => boolean;
  readonly markDirty: () => void;
  readonly setBase: (
    base: ActiveRemovalRecoveryV1["removal"]["sidecarBase"],
  ) => void;
  readonly setFile: (
    file: import("./vault-sidecar/paths").VaultFileCapability,
  ) => void;
  readonly setLayout: (
    layout: import("../../application/persistence").SidecarStorageLayoutV1,
  ) => void;
  readonly setPendingRemoval: (removal: ActiveRemovalRecoveryV1 | null) => void;
  readonly setRawText: (rawText: string) => void;
}

export async function openRuntimePersistenceSessionV1(input: {
  readonly config: RuntimePersistenceConfigV1;
  readonly marker: SidecarMarkerWriter;
  readonly repository: VaultSidecarRepository;
  readonly snapshot: NoteSessionSnapshotV1;
  readonly state: RuntimePersistenceLifecycleStateV1;
}): Promise<NoteSessionSnapshotV1> {
  const opened = await openRuntimePersistenceV1(
    input.config,
    input.repository,
    input.marker,
  );
  if (!isUsableOpen(opened))
    return runtimeOpenSnapshotV1(input.snapshot, opened);
  input.state.setPendingRemoval(
    opened.kind === "removal-pending" ? opened.activeRemoval : null,
  );
  input.state.setBase(opened.base);
  await input.state.createSource(opened);
  if (!input.state.initializeHistory(opened) || !input.state.hasSource()) {
    return runtimeOpenSnapshotV1(input.snapshot, { kind: "conflict" });
  }
  if (opened.kind !== "existing")
    return runtimeOpenSnapshotV1(input.snapshot, opened);
  input.state.setFile(opened.file);
  input.state.setLayout(opened.layout);
  input.state.setRawText(opened.rawText);
  input.state.createSavePipeline();
  for (const attemptId of opened.recoveredAttemptIds)
    input.state.addAttempt(attemptId);
  for (const checkpointId of opened.recoveredCheckpointIds)
    input.state.addCheckpoint(checkpointId);
  if (
    opened.activeRemoval === undefined &&
    (opened.recoveredAttemptIds.length > 0 ||
      opened.recoveredCheckpointIds.length > 0)
  )
    input.state.markDirty();
  return runtimeOpenSnapshotV1(input.snapshot, opened);
}

function isUsableOpen(
  opened: RuntimePersistenceOpenResultV1,
): opened is UsableRuntimePersistenceOpenResultV1 {
  return (
    opened.kind === "existing" ||
    opened.kind === "unannotated" ||
    opened.kind === "removal-pending"
  );
}
