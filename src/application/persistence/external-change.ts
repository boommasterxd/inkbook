import { commandFailure, commandSuccess } from "../note-session/results";
import type {
  CommandResultV1,
  NoteIdentityV1,
  RelocationId,
} from "../note-session/types";
import {
  isNormalizedVaultPath,
  isValidNoteIdentity,
  isValidSidecarBase,
  sameNoteIdentity,
  sameSidecarBase,
  type FileRelocationRecordV1,
  type RecoverySnapshotV1,
  type RecoveryLoadRequestV1,
  type RecoveryStore,
  type SidecarBaseIdentityV1,
} from "../recovery";

const CONFLICT_COPY_LIMIT = 3;
const SIDECAR_SUFFIX = ".inkbook.json";
const CONFLICT_SUFFIX_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/u;
const UTC_BASIC_PATTERN = /^\d{8}T\d{6}Z$/u;
const OWNED_RELOCATION_EVENT_LIMIT = 128;
const RELOAD_TOKEN_MAX_LENGTH = 128;

type AsyncResult = Promise<CommandResultV1<void>>;

export type ExternalSidecarEventV1 =
  | {
      readonly kind: "create";
      readonly path: string;
      readonly observedBase: SidecarBaseIdentityV1;
    }
  | {
      readonly kind: "modify";
      readonly path: string;
      readonly observedBase: SidecarBaseIdentityV1;
    }
  | { readonly kind: "delete"; readonly path: string }
  | {
      readonly kind: "rename";
      readonly oldPath: string;
      readonly newPath: string;
      readonly ownedRelocationId: RelocationId | null;
    };

export interface ExternalSidecarObservationV1 {
  readonly noteIdentity: NoteIdentityV1;
  readonly expectedBase: SidecarBaseIdentityV1;
  readonly event: ExternalSidecarEventV1;
  readonly activeRelocation: FileRelocationRecordV1 | null;
  readonly recoveryLoadRequest: RecoveryLoadRequestV1;
}

export interface ExternalSidecarConflictV1 {
  readonly noteIdentity: NoteIdentityV1;
  readonly expectedBase: SidecarBaseIdentityV1;
  readonly observedBase: SidecarBaseIdentityV1;
  readonly eventKind: "create" | "modify";
  readonly recoverySnapshot: RecoverySnapshotV1;
}

export interface ExternalSidecarDriftV1 {
  readonly noteIdentity: NoteIdentityV1;
  readonly expectedBase: SidecarBaseIdentityV1;
  readonly movedPath: string | null;
  readonly recoverySnapshot: RecoverySnapshotV1;
}

export type ExternalSidecarDecisionV1 =
  | { readonly kind: "unrelated" | "current" | "owned-relocation" }
  | { readonly kind: "conflict"; readonly conflict: ExternalSidecarConflictV1 }
  | { readonly kind: "missing-drift"; readonly drift: ExternalSidecarDriftV1 };

export type ExternalConflictChoiceV1 =
  | { readonly kind: "reload"; readonly confirmedDiscardUnsaved: boolean }
  | {
      readonly kind: "conflict-copy";
      readonly utcBasicTimestamp: string;
      readonly suffix: string;
    }
  | { readonly kind: "cancel-read-only" };

export interface ConflictCopyRequestV1 {
  readonly conflict: ExternalSidecarConflictV1;
  readonly destinationPath: string;
  readonly maximumExistingCopies: number;
}

export interface ExternalReloadPreparationV1 {
  readonly token: string;
  readonly validatedExternalBase: SidecarBaseIdentityV1;
}

export interface ExternalSidecarPortsV1 {
  /** Publishes read-only conflict state without mutating recovery. */
  publishConflict(conflict: ExternalSidecarConflictV1): AsyncResult;
  /** Publishes missing-sidecar drift without clearing or acknowledging recovery. */
  publishMissingDrift(drift: ExternalSidecarDriftV1): AsyncResult;
  /** Re-reads and fully validates external data against the conflict token. */
  prepareExternalReload(
    conflict: ExternalSidecarConflictV1,
  ): Promise<CommandResultV1<ExternalReloadPreparationV1>>;
  /** Publishes only a still-current prepared reload token. */
  publishExternalReload(
    conflict: ExternalSidecarConflictV1,
    preparation: ExternalReloadPreparationV1,
  ): AsyncResult;
  /** Enforces the copy cap and create-if-absent in one serialized host turn. */
  createConflictCopyIfAbsent(request: ConflictCopyRequestV1): AsyncResult;
  remainReadOnly(conflict: ExternalSidecarConflictV1): AsyncResult;
}

export class ExternalSidecarChangeCoordinatorV1 {
  readonly #recovery: RecoveryStore;
  readonly #ports: ExternalSidecarPortsV1;
  readonly #consumedOwnedRelocations = new Set<RelocationId>();

  public constructor(recovery: RecoveryStore, ports: ExternalSidecarPortsV1) {
    this.#recovery = recovery;
    this.#ports = ports;
  }

  public async observe(
    observation: ExternalSidecarObservationV1,
  ): Promise<CommandResultV1<ExternalSidecarDecisionV1>> {
    if (!validObservation(observation))
      return commandFailure("invalid-command");
    const event = observation.event;
    if (event.kind === "create" || event.kind === "modify") {
      return this.#observeWrite(observation, event);
    }
    if (event.kind === "rename" && this.#consumeOwnedRename(observation)) {
      return commandSuccess({ kind: "owned-relocation" });
    }
    const path = eventSourcePath(event);
    if (path !== observation.expectedBase.vaultRelativePath) {
      return commandSuccess({ kind: "unrelated" });
    }
    return this.#publishDrift(observation);
  }

  public async resolve(
    conflict: ExternalSidecarConflictV1,
    choice: ExternalConflictChoiceV1,
  ): AsyncResult {
    if (!validConflict(conflict)) return commandFailure("invalid-command");
    if (choice.kind === "cancel-read-only") {
      return invoke(() => this.#ports.remainReadOnly(conflict));
    }
    if (choice.kind === "reload") {
      return choice.confirmedDiscardUnsaved
        ? this.#reload(conflict)
        : commandFailure("invalid-command");
    }
    const destinationPath = conflictCopyPath(
      conflict.expectedBase.vaultRelativePath,
      choice.utcBasicTimestamp,
      choice.suffix,
    );
    if (!destinationPath.ok) return destinationPath;
    const copied = await invoke(() =>
      this.#ports.createConflictCopyIfAbsent({
        conflict,
        destinationPath: destinationPath.value,
        maximumExistingCopies: CONFLICT_COPY_LIMIT,
      }),
    );
    return copied.ok ? this.#reload(conflict) : copied;
  }

  async #reload(conflict: ExternalSidecarConflictV1): AsyncResult {
    const prepared = await invoke(() =>
      this.#ports.prepareExternalReload(conflict),
    );
    if (!prepared.ok) return prepared;
    if (!validReloadPreparation(conflict, prepared.value)) {
      return commandFailure("sidecar-conflict");
    }
    const discarded = await invoke(() =>
      this.#recovery.discardConfirmedNoteRecovery({
        expectedAttempts: conflict.recoverySnapshot.attempts,
        expectedBase: conflict.expectedBase,
        expectedCheckpoints: conflict.recoverySnapshot.checkpoints,
        noteIdentity: conflict.noteIdentity,
      }),
    );
    return discarded.ok
      ? invoke(() =>
          this.#ports.publishExternalReload(conflict, prepared.value),
        )
      : discarded;
  }

  async #observeWrite(
    observation: ExternalSidecarObservationV1,
    event: Extract<ExternalSidecarEventV1, { kind: "create" | "modify" }>,
  ): Promise<CommandResultV1<ExternalSidecarDecisionV1>> {
    if (event.path !== observation.expectedBase.vaultRelativePath) {
      return commandSuccess({ kind: "unrelated" });
    }
    if (sameSidecarBase(observation.expectedBase, event.observedBase)) {
      return commandSuccess({ kind: "current" });
    }
    const loaded = await invoke(() =>
      this.#recovery.loadNote(observation.recoveryLoadRequest),
    );
    if (!loaded.ok) return loaded;
    const conflict = Object.freeze({
      eventKind: event.kind,
      expectedBase: observation.expectedBase,
      noteIdentity: observation.noteIdentity,
      observedBase: event.observedBase,
      recoverySnapshot: loaded.value,
    });
    const published = await invoke(() => this.#ports.publishConflict(conflict));
    return published.ok
      ? commandSuccess({ conflict, kind: "conflict" })
      : published;
  }

  async #publishDrift(
    observation: ExternalSidecarObservationV1,
  ): Promise<CommandResultV1<ExternalSidecarDecisionV1>> {
    const loaded = await invoke(() =>
      this.#recovery.loadNote(observation.recoveryLoadRequest),
    );
    if (!loaded.ok) return loaded;
    const movedPath =
      observation.event.kind === "rename" ? observation.event.newPath : null;
    const drift = Object.freeze({
      expectedBase: observation.expectedBase,
      movedPath,
      noteIdentity: observation.noteIdentity,
      recoverySnapshot: loaded.value,
    });
    const published = await invoke(() =>
      this.#ports.publishMissingDrift(drift),
    );
    return published.ok
      ? commandSuccess({ drift, kind: "missing-drift" })
      : published;
  }

  #consumeOwnedRename(observation: ExternalSidecarObservationV1): boolean {
    const event = observation.event;
    const record = observation.activeRelocation;
    if (
      event.kind !== "rename" ||
      event.ownedRelocationId === null ||
      event.ownedRelocationId !== record?.relocationId ||
      event.oldPath !== observation.expectedBase.vaultRelativePath ||
      event.oldPath !== record.sourceSidecarPath ||
      event.newPath !== record.destinationSidecarPath ||
      this.#consumedOwnedRelocations.has(record.relocationId)
    ) {
      return false;
    }
    if (this.#consumedOwnedRelocations.size >= OWNED_RELOCATION_EVENT_LIMIT) {
      const oldest = this.#consumedOwnedRelocations.values().next().value;
      if (oldest !== undefined) this.#consumedOwnedRelocations.delete(oldest);
    }
    this.#consumedOwnedRelocations.add(record.relocationId);
    return true;
  }
}

function eventSourcePath(
  event: Extract<ExternalSidecarEventV1, { kind: "delete" | "rename" }>,
): string {
  return event.kind === "delete" ? event.path : event.oldPath;
}

export function conflictCopyPath(
  sidecarPath: string,
  utcBasicTimestamp: string,
  suffix: string,
): CommandResultV1<string> {
  if (
    !isNormalizedVaultPath(sidecarPath) ||
    !sidecarPath.endsWith(SIDECAR_SUFFIX) ||
    !UTC_BASIC_PATTERN.test(utcBasicTimestamp) ||
    !CONFLICT_SUFFIX_PATTERN.test(suffix)
  ) {
    return commandFailure("invalid-command");
  }
  const base = sidecarPath.slice(0, -SIDECAR_SUFFIX.length);
  const path = `${base}.inkbook.conflict-${utcBasicTimestamp}-${suffix}.json`;
  return isNormalizedVaultPath(path)
    ? commandSuccess(path)
    : commandFailure("invalid-command");
}

function validObservation(value: ExternalSidecarObservationV1): boolean {
  return (
    isValidNoteIdentity(value.noteIdentity) &&
    isValidSidecarBase(value.expectedBase) &&
    value.expectedBase.markdownPath ===
      value.noteIdentity.vaultRelativeMarkdownPath &&
    value.recoveryLoadRequest.kind === "existing-sidecar" &&
    sameNoteIdentity(
      value.recoveryLoadRequest.noteIdentity,
      value.noteIdentity,
    ) &&
    sameSidecarBase(value.recoveryLoadRequest.base, value.expectedBase) &&
    validEvent(value.event)
  );
}

function validEvent(event: ExternalSidecarEventV1): boolean {
  if (event.kind === "create" || event.kind === "modify") {
    return (
      isNormalizedVaultPath(event.path) &&
      isValidSidecarBase(event.observedBase) &&
      event.path === event.observedBase.vaultRelativePath
    );
  }
  return event.kind === "delete"
    ? isNormalizedVaultPath(event.path)
    : isNormalizedVaultPath(event.oldPath) &&
        isNormalizedVaultPath(event.newPath) &&
        event.oldPath !== event.newPath;
}

function validConflict(conflict: ExternalSidecarConflictV1): boolean {
  return (
    isValidNoteIdentity(conflict.noteIdentity) &&
    isValidSidecarBase(conflict.expectedBase) &&
    isValidSidecarBase(conflict.observedBase) &&
    conflict.expectedBase.markdownPath ===
      conflict.noteIdentity.vaultRelativeMarkdownPath &&
    conflict.observedBase.markdownPath ===
      conflict.noteIdentity.vaultRelativeMarkdownPath &&
    conflict.expectedBase.vaultRelativePath ===
      conflict.observedBase.vaultRelativePath &&
    !sameSidecarBase(conflict.expectedBase, conflict.observedBase)
  );
}

function validReloadPreparation(
  conflict: ExternalSidecarConflictV1,
  preparation: ExternalReloadPreparationV1,
): boolean {
  return (
    preparation.token.length > 0 &&
    preparation.token.length <= RELOAD_TOKEN_MAX_LENGTH &&
    !preparation.token.includes("\0") &&
    isValidSidecarBase(preparation.validatedExternalBase) &&
    sameSidecarBase(preparation.validatedExternalBase, conflict.observedBase)
  );
}

async function invoke<T>(
  action: () => Promise<CommandResultV1<T>>,
): Promise<CommandResultV1<T>> {
  try {
    return await action();
  } catch {
    return commandFailure("recovery-unavailable");
  }
}
