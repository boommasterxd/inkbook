# Operations, Sessions, and Recovery

This document owns canonical annotation operations, command admission, note-session states, editor-history envelopes, recovery records, and the `RecoveryStore` port. [Source Coordination and Persistence Operations](18-source-coordination-and-persistence-operations.md) owns offset maps, multi-pane source admission, initial-sidecar state, and relocation or removal validation. [Architecture](04-architecture.md) owns package and lifecycle boundaries. [Domain Model and Codecs](15-domain-model-and-codecs.md) owns scene records. [Sidecar Persistence](07-sidecar-persistence.md) owns Vault writes and file conflicts.

## 1. Operation Identity and Common Contract

Operation, history-entry, effect, recovery-attempt, source-checkpoint, relocation, and removal IDs use a distinct ASCII prefix followed by the 128-bit Base32 payload defined for domain IDs. Prefixes are `op_`, `he_`, `eff_`, `ra_`, `scp_`, `rel_`, and `rm_`. IDs are caller-generated before admission and unique within one Vault installation. A `HistoryEntryId` is stable for the actionable host-history entry. Each initial Forward, Undo, or Redo dispatch receives a fresh `OperationId`, which remains stable only across retries of that one dispatch. Reusing any ID with different canonical request bytes is a conflict and never a second mutation. Every numeric branded counter is a positive safe integer, increases without wrap in its declared scope, and rejects exhaustion before mutation.

```ts
export type OperationId = string & { readonly __brand: "OperationId" };
export type HistoryEntryId = string & { readonly __brand: "HistoryEntryId" };
export type HostEffectId = string & { readonly __brand: "HostEffectId" };
export type RecoveryAttemptId = string & {
  readonly __brand: "RecoveryAttemptId";
};
export type SourceCheckpointId = string & {
  readonly __brand: "SourceCheckpointId";
};
export type RelocationId = string & { readonly __brand: "RelocationId" };
export type RemovalId = string & { readonly __brand: "RemovalId" };
export type ViewId = string & { readonly __brand: "ViewId" };
export type HistoryEpoch = number & { readonly __brand: "HistoryEpoch" };
export type HostTransactionSequence = number & {
  readonly __brand: "HostTransactionSequence";
};
export type SessionOrder = number & { readonly __brand: "SessionOrder" };
export type SidecarRevision = number & { readonly __brand: "SidecarRevision" };
export type SaveGeneration = number & { readonly __brand: "SaveGeneration" };
export type SourceGeneration = number & {
  readonly __brand: "SourceGeneration";
};
export type Sha256Digest = string & { readonly __brand: "Sha256Digest" };

export interface NoteIdentityV1 {
  readonly vaultIdHint: string;
  readonly vaultRelativeMarkdownPath: string;
}

export interface OperationMetaV1 {
  readonly operationId: OperationId;
  readonly historyEntryId: HistoryEntryId;
  readonly direction: "forward" | "inverse";
  readonly expectedSceneRevision: SceneRevision;
  readonly historyEpoch: HistoryEpoch;
}

export interface ComponentReplacementV1<T> {
  readonly elementId: ElementId;
  readonly prior: T;
  readonly replacement: T;
}
```

Every patch is immutable, finite, size-bounded, revision-free, and contains sufficient exact prior and replacement values to derive its inverse without reading mutable state. An operation is one fresh dispatch envelope around one such patch. Applying it validates all IDs and the expected current scene revision first, computes one complete replacement scene, assigns fresh monotonic publication revisions, and publishes nothing on failure. Inversion swaps prior and replacement values and reverses atomic member order where required. Applying the inverse restores every non-revision canonical value exactly; revisions intentionally remain monotonic and are excluded from inverse equality.

## 2. Closed Annotation Operation Union

```ts
export interface AnnotationOperationV1 extends OperationMetaV1 {
  readonly patch: AnnotationPatchV1;
}

export interface AnnotationHistoryEntryV1 {
  readonly historyEntryId: HistoryEntryId;
  readonly historyEpoch: HistoryEpoch;
  readonly forward: AnnotationPatchV1;
  readonly inverse: AnnotationPatchV1;
}

export type AnnotationPatchV1 =
  | CreateElementsPatchV1
  | DeleteElementsPatchV1
  | ReplaceGeometryPatchV1
  | ReplaceStylePatchV1
  | ReplaceBindingPatchV1
  | ReplaceLinearGeometryPatchV1
  | ReplaceObjectOrderPatchV1
  | ReplaceGroupsPatchV1
  | ReplaceNoteAppearancePatchV1
  | AtomicBatchPatchV1;

export interface CreateElementsPatchV1 {
  readonly kind: "create-elements";
  readonly elements: readonly SceneElementValueV1[];
  readonly placement: OrderPlacementV1;
}

export interface DeleteElementsPatchV1 {
  readonly kind: "delete-elements";
  readonly elements: readonly SceneElementValueV1[];
  readonly priorPlacement: OrderPlacementV1;
}

export interface ReplaceGeometryPatchV1 {
  readonly kind: "replace-geometry";
  readonly changes: readonly ComponentReplacementV1<NonLinearGeometryV1>[];
}

export interface ReplaceStylePatchV1 {
  readonly kind: "replace-style";
  readonly changes: readonly ComponentReplacementV1<CanonicalStyleV1>[];
}

export interface ReplaceBindingPatchV1 {
  readonly kind: "replace-binding";
  readonly changes: readonly ComponentReplacementV1<ElementBinding>[];
}

export interface ReplaceLinearGeometryPatchV1 {
  readonly kind: "replace-linear-geometry";
  readonly changes: readonly ComponentReplacementV1<LinearGeometryV1>[];
}

export interface OrderPlacementV1 {
  readonly movedElementIds: readonly ElementId[];
  readonly predecessorId: ElementId | null;
  readonly successorId: ElementId | null;
}

export interface ReplaceObjectOrderPatchV1 {
  readonly kind: "replace-object-order";
  readonly prior: OrderPlacementV1;
  readonly replacement: OrderPlacementV1;
}

export interface ReplaceGroupsPatchV1 {
  readonly kind: "replace-groups";
  readonly changes: readonly GroupReplacementV1[];
}

export interface GroupReplacementV1 {
  readonly groupId: GroupId;
  readonly prior: GroupRecordV1 | null;
  readonly replacement: GroupRecordV1 | null;
}

export interface ReplaceNoteAppearancePatchV1 {
  readonly kind: "replace-note-appearance";
  readonly prior: NoteAppearanceV1;
  readonly replacement: NoteAppearanceV1;
}

export interface AtomicBatchPatchV1 {
  readonly kind: "atomic-batch";
  readonly operations: readonly BatchMemberV1[];
}

export type BatchMemberV1 = Exclude<AnnotationPatchV1, AtomicBatchPatchV1>;
```

`BatchMemberV1` is the patch union without `AtomicBatchPatchV1`. A batch is non-empty, contains no nested batch, uses one outer dispatch identity and expected scene revision, and publishes one scene revision. It is used for aggregate transforms, transform plus rebind, target deletion plus Line or Arrow endpoint detachment, and Group operations. One failure rejects the entire batch. An `AnnotationHistoryEntryV1` is created before initial admission and retains one validated forward and inverse patch pair while its host effect remains actionable.

For `create-elements`, `movedElementIds` equals the absent created IDs and inserts them between validated adjacent anchors without a removal step. For `delete-elements`, it equals present deleted IDs whose current placement matches `priorPlacement` and removes them without reinsertion. Only `replace-object-order` removes the named present IDs and inserts them between the named adjacent predecessor and successor in the remaining order. Both anchors may be null only when the applicable remaining order is empty. The moved IDs retain their listed relative order. This permits work proportional to moved members plus indexed order updates without serializing a complete 10,000-element order for a one-element move.

Create, delete, Group, and attachment operations are dependency-closed. Deleting a target includes every required Line or Arrow endpoint detachment and Group change in the same batch. `replace-groups.changes` is non-empty, contains each `groupId` once in ascending Unicode code-point order, and carries only created, deleted, or value-changed records; an unchanged pair is invalid. Validation applies the sparse changes to the persistent Group store and checks only affected ancestor, descendant, membership, and contiguous-order indices plus their dependency closure. It MUST NOT copy or traverse the complete Group table for one local edit. A direct operation that would leave an unresolved ID, invalid Group, invalid port, or incomplete object order is rejected.

## 3. Revision Rules and Command Results

A successful dispatch produces `scene.revision = expectedSceneRevision + 1`. Every created or changed component receives that new scene revision as its component revision; every unrelated component revision is preserved. Geometry replacement changes only affected geometry revisions, style replacement only affected style revisions, and binding replacement only affected binding revisions. Linear geometry replacement is the sole authority for Line and Arrow endpoint attachments and curve geometry, advances each affected geometry revision exactly once, and updates the reverse attachment index atomically. A batch may advance multiple component revisions on one element once each but still publishes one scene revision. Forward, Undo, and Redo each use a fresh operation envelope against the current scene. Repeated Undo or Redo and branch-after-Undo therefore cannot restore an earlier revision value or create revision ABA.

```ts
export type CommandErrorCodeV1 =
  | "invalid-command"
  | "stale-scene"
  | "stale-source"
  | "stale-layout"
  | "history-unavailable"
  | "history-lease-unavailable"
  | "recovery-unavailable"
  | "recovery-limit"
  | "resource-limit"
  | "read-only-mode"
  | "sidecar-drift"
  | "sidecar-conflict"
  | "relocation-pending"
  | "disposed";

export type CommandResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: CommandErrorCodeV1 };
```

User-visible messages are localized adapter output and do not expose internal paths or stack traces. Domain and application code return closed errors rather than throwing for expected rejection. Programmer defects and corrupt trusted invariants may throw into one bounded error boundary, which blocks mutation and preserves recovery.

## 4. Note Session State and Admission

```ts
export type SessionLifecycleV1 = "opening" | "ready" | "disposing" | "disposed";
export type HistoryLeaseV1 =
  | { readonly kind: "unowned" }
  | {
      readonly kind: "owned";
      readonly ownerViewId: ViewId;
      readonly epoch: HistoryEpoch;
    }
  | {
      readonly kind: "closing";
      readonly ownerViewId: ViewId;
      readonly epoch: HistoryEpoch;
    }
  | { readonly kind: "blocked"; readonly reason: CommandErrorCodeV1 };

export type EffectiveViewAccessV1 =
  | { readonly kind: "mutable"; readonly epoch: HistoryEpoch }
  | { readonly kind: "secondary-read-only"; readonly ownerViewId: ViewId }
  | { readonly kind: "reading-read-only" }
  | { readonly kind: "blocked"; readonly reason: CommandErrorCodeV1 };

export interface FirstSidecarPendingV1 {
  readonly noteIdentity: NoteIdentityV1;
  readonly operationId: OperationId;
  readonly historyEntryId: HistoryEntryId;
  readonly recoveryAttemptId: RecoveryAttemptId;
  readonly expectedVaultRelativePath: string;
  readonly expectedSettingsRevision: SettingsRevision;
  readonly expectedSourceGeneration: SourceGeneration;
  readonly expectedSourceDigest: Sha256Digest;
}

export type PersistenceStateV1 =
  | { readonly kind: "unannotated" }
  | {
      readonly kind: "first-sidecar-pending";
      readonly pending: FirstSidecarPendingV1;
    }
  | { readonly kind: "clean"; readonly sidecarRevision: SidecarRevision }
  | { readonly kind: "dirty"; readonly generation: SaveGeneration }
  | { readonly kind: "saving"; readonly generation: SaveGeneration }
  | { readonly kind: "conflict" }
  | { readonly kind: "drift" }
  | { readonly kind: "relocating"; readonly relocationId: RelocationId }
  | { readonly kind: "newer-version" };

export type SourceStateV1 =
  | {
      readonly kind: "durable";
      readonly generation: SourceGeneration;
      readonly digest: Sha256Digest;
    }
  | {
      readonly kind: "checkpoint-pending";
      readonly generation: SourceGeneration;
    }
  | { readonly kind: "reattaching"; readonly targetDigest: Sha256Digest };

export interface NoteSessionSnapshotV1 {
  readonly lifecycle: SessionLifecycleV1;
  readonly historyLease: HistoryLeaseV1;
  readonly persistence: PersistenceStateV1;
  readonly source: SourceStateV1;
  readonly scene: RuntimeSceneStateV1;
}
```

One pure `admitCommand(snapshot, view, request)` function derives `EffectiveViewAccessV1` from the session lease, concrete view mode, and view identity, then returns either a revision-bound admission token or one closed error. Only `ready`, effectively mutable, non-conflicting, non-drift, non-relocating sessions with durable source state and conforming recovery may admit annotation mutation. An `unannotated` session may admit its first command through the identity-bound pending protocol below. Read-only projections may still select and inspect elements. A command revalidates the admission token immediately before history dispatch and publication.

An `unannotated` session has no sidecar base, an empty runtime scene at revision `0`, component-free object order and Groups, and the validated default note appearance captured from current plugin settings. Entering `first-sidecar-pending` preserves that runtime scene and binds exactly one operation, history entry, recovery attempt, destination path, settings revision, source generation, and source digest. Only that matching revalidated dispatch may publish scene revision `1` and create sidecar revision `1`.

When the lease is `unowned`, the first otherwise valid annotation mutation from a supported editable pane acquires a new monotonic history epoch. Merely focusing, selecting, scrolling, typing Markdown, or opening a toolbar does not acquire it. The owner retains the lease while its view and actionable annotation effects exist. Disposal changes the lease to `closing`, settles or blocks pending intents, recovery-protects the current scene, closes the epoch, and only then returns it to `unowned` so a later pane can acquire the next epoch. Old effects are permanently stale.

The session queue is serialized and non-reentrant. Its private turn union is closed over user commands, host-history deliveries, lifecycle, source, recovery, persistence, worker, and view-publication turns. It enforces the per-session and plugin-wide entry and byte limits in `RESOURCE_BUDGET_V1`. Each session permanently reserves one lifecycle slot and one host-history slot of 64 KiB each; ordinary work cannot consume them, and a larger emergency turn fails closed before retaining its payload. Each admitted asynchronous operation precharges one completion slot and its worst-case retained payload until terminal settlement. Admission rejects or backpressures before retaining an over-limit payload. Only the latest revision-superseded view, worker, save, or checkpoint turn may replace an older turn of the same identity; user commands, history transitions, recovery acknowledgements, and lifecycle turns are never dropped. It never awaits an event whose handler requires the retained queue turn. Listener notifications, worker results, view publications, source transactions, and retries enter later turns.

## 5. Host-History Effect Lifecycle

```ts
export interface HostEffectEnvelopeV1 {
  readonly effectId: HostEffectId;
  readonly noteIdentity: NoteIdentityV1;
  readonly historyEpoch: HistoryEpoch;
  readonly historyEntryId: HistoryEntryId;
  readonly direction: "forward" | "inverse";
}

export interface HostEffectDeliveryV1 {
  readonly envelope: HostEffectEnvelopeV1;
  readonly transactionSequence: HostTransactionSequence;
}

export type HostEffectLifecycleV1 = "admitting" | "applied" | "undone";
```

The host payload is a bounded immutable handle, not a complete scene. Every `ViewPlugin` delivery wraps it in `HostEffectDeliveryV1` with a positive monotonic transaction sequence scoped to the concrete editor and history epoch; retries reuse the same sequence. The application retains the associated `AnnotationHistoryEntryV1` with structural sharing and the accepted sequence high-water mark while the host exposes the effect as actionable. A sequence equal to an accepted transition is an idempotent retry, a lower sequence is stale, and only a greater sequence in the lifecycle-allowed direction may create a fresh dispatch. The initial forward effect is valid only from `admitting`; after durable `host-recorded-forward` it becomes `applied`. An inverse effect is valid only from `applied` and becomes `undone`. A greater-sequence forward effect delivered while `undone` is Redo and becomes `applied`. Each accepted direction creates a fresh `AnnotationOperationV1` with a fresh `OperationId` and the current expected scene revision; a retry reuses only that dispatch identity. Every other sequence, lifecycle, note, effect, epoch, owner, history-entry, or current-revision mismatch blocks the effect without scene mutation.

Branch truncation releases unreachable history entries and their shared records. Editor disposal, plugin unload, or bridge reconfiguration MUST NOT release an `AnnotationHistoryEntryV1` while the host can still deliver its effect. The adapter either proves that the host event becomes unreachable without consuming a visible history step or restores the complete bounded actionable-history table before accepting history intents after reload. Eviction MUST NOT leave a host-actionable handle without its exact forward and inverse patches. If bounded retention and restoration cannot be proven for one supported host cell, annotation mutation is unsupported in that cell.

## 6. Recovery Records and Store

```ts
export interface SidecarBaseIdentityV1 {
  readonly vaultRelativePath: string;
  readonly revision: SidecarRevision | null;
  readonly rawTextSha256: Sha256Digest | null;
  readonly markdownPath: string;
}

export interface RecoveryAttemptCommonV1 {
  readonly attemptId: RecoveryAttemptId;
  readonly operationId: OperationId;
  readonly historyEntryId: HistoryEntryId;
  readonly historyEpoch: HistoryEpoch;
  readonly sessionOrder: SessionOrder;
  readonly base: SidecarBaseIdentityV1;
  readonly expectedSceneRevision: SceneRevision;
  readonly expectedSourceGeneration: SourceGeneration;
  readonly expectedSourceDigest: Sha256Digest;
}

export interface HostAcknowledgementV1 {
  readonly editorViewId: ViewId;
  readonly effectId: HostEffectId;
  readonly direction: "forward" | "inverse";
  readonly transactionSequence: HostTransactionSequence;
}

export interface PreparedForwardAttemptV1 extends RecoveryAttemptCommonV1 {
  readonly kind: "prepared-forward";
  readonly forward: AnnotationPatchV1;
  readonly inverse: AnnotationPatchV1;
}

export interface HostRecordedForwardAttemptV1 extends RecoveryAttemptCommonV1 {
  readonly kind: "host-recorded-forward";
  readonly acknowledgement: HostAcknowledgementV1;
  readonly forward: AnnotationPatchV1;
  readonly inverse: AnnotationPatchV1;
}

export interface HostRecordedDirectionAttemptV1 extends RecoveryAttemptCommonV1 {
  readonly kind: "host-recorded-undo" | "host-recorded-redo";
  readonly acknowledgement: HostAcknowledgementV1;
  readonly directionPatch: AnnotationPatchV1;
}

export type RecoveryAttemptV1 =
  | PreparedForwardAttemptV1
  | HostRecordedForwardAttemptV1
  | HostRecordedDirectionAttemptV1;

export interface SidecarRecoveryAcknowledgementV1 {
  readonly noteIdentity: NoteIdentityV1;
  readonly expectedPriorBase: SidecarBaseIdentityV1;
  readonly acknowledgedReplacementBase: SidecarBaseIdentityV1;
  readonly coveredAttemptIds: readonly RecoveryAttemptId[];
  readonly coveredCheckpointIds: readonly SourceCheckpointId[];
  readonly sidecarRevision: SidecarRevision;
  readonly sceneRevision: SceneRevision;
  readonly sourceGeneration: SourceGeneration;
  readonly sourceDigest: Sha256Digest;
}

export type FileRelocationStepV1 =
  | "prepared"
  | "sidecar-moved"
  | "identities-rekeyed"
  | "sidecar-metadata-saved"
  | "marker-saved"
  | "checkpoint-acknowledged"
  | "complete";

export interface FileRelocationRecordV1 {
  readonly kind: "markdown-file" | "sidecar-location";
  readonly relocationId: RelocationId;
  readonly noteIdentity: NoteIdentityV1;
  readonly sidecarBase: SidecarBaseIdentityV1;
  readonly expectedSceneRevision: SceneRevision;
  readonly expectedSettingsRevision: SettingsRevision;
  readonly sourceMarkdownPath: string;
  readonly destinationMarkdownPath: string;
  readonly sourceSidecarPath: string;
  readonly destinationSidecarPath: string;
  readonly step: FileRelocationStepV1;
}

export interface PrefixRelocationRecordV1 {
  readonly kind: "folder-prefix" | "storage-root";
  readonly relocationId: RelocationId;
  readonly priorPrefix: string;
  readonly replacementPrefix: string;
  readonly generation: number;
  readonly expectedSettingsRevision: SettingsRevision;
  readonly cursor: number;
  readonly admittedRecordCount: number;
  readonly step: "prepared" | "processing" | "complete";
}

export type RelocationRecordV1 =
  FileRelocationRecordV1 | PrefixRelocationRecordV1;

export interface RelocationTransitionV1 {
  readonly expected: RelocationRecordV1;
  readonly replacement: RelocationRecordV1;
}

export interface RemovalRecordV1 {
  readonly kind: "annotation-removal";
  readonly removalId: RemovalId;
  readonly noteIdentity: NoteIdentityV1;
  readonly sidecarBase: SidecarBaseIdentityV1;
  readonly expectedSceneRevision: SceneRevision;
  readonly deadlineEpochMs: number;
  readonly trashAcknowledged: boolean;
  readonly deleteEventAcknowledged: boolean;
  readonly markerState: "present" | "removing" | "removed";
}

export interface RemovalTransitionV1 {
  readonly expected: RemovalRecordV1;
  readonly replacement: RemovalRecordV1;
}

export interface RecoverySagaCompletionV1 {
  readonly kind: "relocation" | "removal";
  readonly id: RelocationId | RemovalId;
  readonly expectedTerminalRecordSha256: Sha256Digest;
}

export interface RecoveryRekeyV1 {
  readonly prior: NoteIdentityV1;
  readonly replacement: NoteIdentityV1;
  readonly relocationId: RelocationId;
}

export interface ExistingSidecarRecoveryLoadRequestV1 {
  readonly kind: "existing-sidecar";
  readonly noteIdentity: NoteIdentityV1;
  readonly base: SidecarBaseIdentityV1;
  readonly validatedSidecarSourceGeneration: SourceGeneration;
  readonly validatedSidecarSourceDigest: Sha256Digest;
  readonly currentMarkdownDigest: Sha256Digest;
  readonly currentMarkdownUtf16Length: number;
}

export interface AbsentFirstSidecarRecoveryLoadRequestV1 {
  readonly kind: "absent-first-sidecar";
  readonly noteIdentity: NoteIdentityV1;
  readonly base: SidecarBaseIdentityV1;
  readonly expectedVaultRelativePath: string;
  readonly currentMarkdownDigest: Sha256Digest;
  readonly currentMarkdownUtf16Length: number;
}

export type RecoveryLoadRequestV1 =
  | ExistingSidecarRecoveryLoadRequestV1
  | AbsentFirstSidecarRecoveryLoadRequestV1;

export interface RecoverySnapshotV1 {
  readonly attempts: readonly RecoveryAttemptV1[];
  readonly checkpoints: readonly SourceCheckpointOperationV1[];
  readonly relocations: readonly RelocationRecordV1[];
  readonly removals: readonly RemovalRecordV1[];
}
```

`PreparedForwardAttemptV1` contains the compact revision-free forward and inverse patches and no host identity. `HostRecordedForwardAttemptV1` additionally contains the acknowledged editor and effect identities. Undo and Redo attempts contain their acknowledged identities and the compact direction patch required for crash recovery. A prepared attempt never auto-replays. Every checkpoint and attempt receives one unique strictly increasing `SessionOrder` in admission order. A host-recorded attempt may replay at the unique checkpoint-chain node matching its expected source generation and digest, subject to its note, history entry, epoch, base, and expected scene revision. Recovery then rebases every binding introduced or replaced by that patch through the remaining validated checkpoint suffix. A mismatch or ambiguity publishes nothing and enters bounded external-change reattachment or explicit review.

```ts
export interface RecoveryStore {
  prepareForward(
    attempt: PreparedForwardAttemptV1,
  ): Promise<CommandResultV1<void>>;
  recordForward(
    attemptId: RecoveryAttemptId,
    acknowledgement: HostAcknowledgementV1,
  ): Promise<CommandResultV1<void>>;
  appendDirection(
    attempt: HostRecordedDirectionAttemptV1,
  ): Promise<CommandResultV1<void>>;
  appendSourceCheckpoint(
    checkpoint: SourceCheckpointOperationV1,
  ): Promise<CommandResultV1<void>>;
  acknowledgeSidecar(
    request: SidecarRecoveryAcknowledgementV1,
  ): Promise<CommandResultV1<void>>;
  beginRelocation(record: RelocationRecordV1): Promise<CommandResultV1<void>>;
  advanceRelocation(
    request: RelocationTransitionV1,
  ): Promise<CommandResultV1<void>>;
  beginRemoval(record: RemovalRecordV1): Promise<CommandResultV1<void>>;
  advanceRemoval(request: RemovalTransitionV1): Promise<CommandResultV1<void>>;
  completeSaga(
    request: RecoverySagaCompletionV1,
  ): Promise<CommandResultV1<void>>;
  rekeyNote(request: RecoveryRekeyV1): Promise<CommandResultV1<void>>;
  loadNote(
    request: RecoveryLoadRequestV1,
  ): Promise<CommandResultV1<RecoverySnapshotV1>>;
  dispose(): Promise<void>;
}
```

Each mutating method is one atomic transaction and uses compare-and-swap over its expected prior state. V1 selects a transactional IndexedDB adapter. The database schema is versioned independently from sidecars. `localStorage`, `saveLocalStorage()`, plugin data JSON, and the Vault are not conforming recovery backends. Phase 0 MUST prove the host capability and transaction behavior on every supported desktop and Android environment; Phase 1 turns that probe into the fully tested production adapter. Failure keeps annotation mutation read-only.

The store enforces the 32 MiB global and 8 MiB per-note budgets, 16,384 records globally, 4,096 records per note, and at most 512 retained direct successors of one base before accepting a write. A single operation that cannot fit is rejected before history or scene publication. Records are indexed by note identity, base path, base revision, base digest, and `SessionOrder`; a note operation MUST NOT scan another note. `acknowledgeSidecar()` compares `expectedPriorBase`, requires `sidecarRevision === acknowledgedReplacementBase.revision`, validates the acknowledged replacement path and raw digest, deletes exactly the listed covered attempts and checkpoints, and rebases only the indexed retained direct successors from that prior base to `acknowledgedReplacementBase` in the same atomic transaction. A gap, fork, conflicting base, non-successor record, missing covered ID, acknowledgement mismatch, or successor-limit overflow aborts cleanup and enters recovery conflict. It never removes an actionable host envelope or history entry. Recovery records contain no Markdown text.
