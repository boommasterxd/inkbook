import {
  commandFailure,
  commandSuccess,
  type CommandResultV1,
  type NoteIdentityV1,
  type NoteSessionSnapshotV1,
  type NoteSessionV1,
  type NoteSessionRegistryV1,
  type RelocationId,
} from "../../application/note-session";
import { TFile, TFolder } from "obsidian";
import type {
  FileRelocationRecordV1,
  PrefixRelocationRecordV1,
} from "../../application/recovery";
import type { RecoveryStore } from "../../application/recovery";
import {
  beginFileRelocation,
  resumeFileRelocation,
  type FileRelocationPortsV1,
} from "../../application/persistence";
import type { RuntimePersistenceV1 } from "./runtime-persistence";
import type { ObsidianVaultChangeV1 } from "./vault-sidecar/host-events";
import {
  runtimeFolderPathV1,
  runtimeMarkdownPathV1,
  runtimeNoteIdentityV1,
} from "./vault-sidecar/relocation";

export interface RuntimeRelocationGatePortsV1 {
  readonly publish: (
    owner: RuntimePersistenceV1,
    relocationId: RelocationId | null,
  ) => Promise<CommandResultV1<void>>;
  readonly registry: NoteSessionRegistryV1;
}

export class RuntimeRelocationGateV1 {
  readonly #active = new Map<RuntimePersistenceV1, RelocationId>();
  readonly #prefixOwners = new Map<
    RelocationId,
    ReadonlySet<RuntimePersistenceV1>
  >();
  readonly #ports: RuntimeRelocationGatePortsV1;

  public constructor(ports: RuntimeRelocationGatePortsV1) {
    this.#ports = ports;
  }

  public isActive(owner: RuntimePersistenceV1): boolean {
    return this.#active.has(owner);
  }

  public maintenancePorts(
    findOwner: (identity: NoteIdentityV1) => RuntimePersistenceV1 | undefined,
    portsForOwner: (owner: RuntimePersistenceV1) => FileRelocationPortsV1,
  ): FileRelocationPortsV1 {
    return {
      admitMutations: (record) =>
        this.#withFile(record, findOwner, portsForOwner, (ports) =>
          ports.admitMutations(record),
        ),
      awaitSourceCheckpoint: (record) =>
        this.#withFile(record, findOwner, portsForOwner, (ports) =>
          ports.awaitSourceCheckpoint(record),
        ),
      rekeyOwnedIdentities: (record) =>
        this.#withFile(record, findOwner, portsForOwner, (ports) =>
          ports.rekeyOwnedIdentities(record),
        ),
      saveMarker: (record) =>
        this.#withFile(record, findOwner, portsForOwner, (ports) =>
          ports.saveMarker(record),
        ),
      saveSidecarMetadata: (record) =>
        this.#withFile(record, findOwner, portsForOwner, (ports) =>
          ports.saveSidecarMetadata(record),
        ),
      settleSaveAndMoveSidecar: (record) =>
        this.#withFile(record, findOwner, portsForOwner, (ports) =>
          ports.settleSaveAndMoveSidecar(record),
        ),
    };
  }

  public retainPrefix(
    relocationId: RelocationId,
    owners: ReadonlySet<RuntimePersistenceV1>,
  ): void {
    this.#prefixOwners.set(relocationId, owners);
  }

  public async activate(
    owner: RuntimePersistenceV1,
    identity: NoteIdentityV1,
    relocationId: RelocationId,
  ): Promise<boolean> {
    const active = this.#active.get(owner);
    if (active !== undefined) {
      return (
        active === relocationId &&
        (await this.#ports.publish(owner, relocationId)).ok
      );
    }
    this.#active.set(owner, relocationId);
    this.#ports.registry.suspendOverlay(identity);
    return (await this.#ports.publish(owner, relocationId)).ok;
  }

  public async finishFile(
    owner: RuntimePersistenceV1,
    record: FileRelocationRecordV1,
  ): Promise<CommandResultV1<void>> {
    if (!this.#ports.registry.readmitOverlay(record.noteIdentity)) {
      return commandFailure("relocation-pending");
    }
    owner.setActiveRelocation(null);
    return this.#active.get(owner) === record.relocationId
      ? this.#finishOwner(owner, record.relocationId)
      : commandSuccess(undefined);
  }

  public async finishPrefix(
    relocationId: RelocationId,
  ): Promise<CommandResultV1<void>> {
    const owners = this.#prefixOwners.get(relocationId);
    if (owners === undefined) return commandFailure("relocation-pending");
    for (const owner of owners) {
      const finished = await this.#finishOwner(owner, relocationId);
      if (!finished.ok) return finished;
    }
    this.#prefixOwners.delete(relocationId);
    return commandSuccess(undefined);
  }

  public async ensurePrefix(
    record: PrefixRelocationRecordV1,
    recovery: RecoveryStore,
    findOwner: (
      first: NoteIdentityV1,
      second: NoteIdentityV1,
    ) => RuntimePersistenceV1 | undefined,
  ): Promise<boolean> {
    if (this.#prefixOwners.has(record.relocationId)) return true;
    const owners = new Set<RuntimePersistenceV1>();
    for (let ordinal = 0; ordinal < record.admittedRecordCount; ordinal += 1) {
      const loaded = await recovery.loadPrefixRelocationMember({
        ordinal,
        relocationId: record.relocationId,
      });
      if (!loaded.ok) return false;
      const owner = findOwner(
        loaded.value.priorNoteIdentity,
        loaded.value.replacementNoteIdentity,
      );
      if (
        owner === undefined ||
        !(await this.activate(
          owner,
          loaded.value.priorNoteIdentity,
          record.relocationId,
        ))
      ) {
        return false;
      }
      owners.add(owner);
    }
    this.#prefixOwners.set(record.relocationId, owners);
    return true;
  }

  async #finishOwner(
    owner: RuntimePersistenceV1,
    relocationId: RelocationId,
  ): Promise<CommandResultV1<void>> {
    if (this.#active.get(owner) !== relocationId) {
      return commandFailure("relocation-pending");
    }
    const published = await this.#ports.publish(owner, null);
    if (!published.ok) return published;
    this.#active.delete(owner);
    return commandSuccess(undefined);
  }

  async #withFile(
    record: FileRelocationRecordV1,
    findOwner: (identity: NoteIdentityV1) => RuntimePersistenceV1 | undefined,
    portsForOwner: (owner: RuntimePersistenceV1) => FileRelocationPortsV1,
    effect: (ports: FileRelocationPortsV1) => Promise<CommandResultV1<void>>,
  ): Promise<CommandResultV1<void>> {
    const owner = findOwner(record.noteIdentity);
    if (
      owner === undefined ||
      !(await this.activate(owner, record.noteIdentity, record.relocationId))
    ) {
      return commandFailure("relocation-pending");
    }
    owner.setActiveRelocation(record);
    return effect(portsForOwner(owner));
  }
}

export class RuntimeRelocationStatusPublisherV1 {
  readonly #previous = new Map<
    RuntimePersistenceV1,
    NoteSessionSnapshotV1["persistence"]
  >();
  readonly #sessions = new Map<RuntimePersistenceV1, NoteSessionV1>();

  public register(owner: RuntimePersistenceV1, session: NoteSessionV1): void {
    this.#sessions.set(owner, session);
  }

  public unregister(owner: RuntimePersistenceV1): void {
    this.#sessions.delete(owner);
    this.#previous.delete(owner);
  }

  public async publish(
    owner: RuntimePersistenceV1,
    relocationId: RelocationId | null,
  ): Promise<CommandResultV1<void>> {
    const session = this.#sessions.get(owner);
    if (session === undefined) return commandSuccess(undefined);
    if (relocationId !== null && !this.#previous.has(owner)) {
      this.#previous.set(owner, session.snapshot.persistence);
    }
    const previous = this.#previous.get(owner);
    if (relocationId === null && previous === undefined) {
      return commandFailure("relocation-pending");
    }
    const result = await session.enqueue({
      kind: "lifecycle",
      retainedBytes: 0,
      run: ({ publish, snapshot }) => {
        let persistence: NoteSessionSnapshotV1["persistence"] | undefined =
          snapshot.persistence;
        if (relocationId !== null) {
          persistence = { kind: "relocating", relocationId };
        } else if (snapshot.persistence.kind === "relocating") {
          persistence = previous;
        }
        if (persistence !== undefined) publish({ ...snapshot, persistence });
      },
    });
    if (result.kind !== "completed") {
      return commandFailure(
        result.kind === "rejected" && result.reason === "disposed"
          ? "disposed"
          : "relocation-pending",
      );
    }
    if (relocationId === null) this.#previous.delete(owner);
    return commandSuccess(undefined);
  }
}

interface RuntimeRenameControllerV1 {
  acceptFileRename(
    prior: NoteIdentityV1,
    replacement: NoteIdentityV1,
  ): Promise<void>;
  acceptFolderRename(
    priorPrefix: string,
    replacementPrefix: string,
    vaultId: string,
  ): Promise<void>;
}

export async function processRuntimeRenameV1(options: {
  readonly change: Extract<ObsidianVaultChangeV1, { readonly kind: "rename" }>;
  readonly registry: NoteSessionRegistryV1;
  readonly relocation: RuntimeRenameControllerV1 | null;
  readonly vaultId: string;
}): Promise<void> {
  const { change, relocation, registry, vaultId } = options;
  if (change.target instanceof TFile) {
    const prior = runtimeMarkdownPathV1(change.oldPath);
    const replacement = runtimeMarkdownPathV1(change.target.path);
    if (prior === null || replacement === null) return;
    const priorIdentity = runtimeNoteIdentityV1(vaultId, prior);
    const replacementIdentity = runtimeNoteIdentityV1(vaultId, replacement);
    if (relocation !== null) {
      await relocation.acceptFileRename(priorIdentity, replacementIdentity);
    } else {
      await registry.rekey(priorIdentity, replacementIdentity);
    }
    return;
  }
  if (!(change.target instanceof TFolder)) return;
  const priorPrefix = runtimeFolderPathV1(change.oldPath);
  const replacementPrefix = runtimeFolderPathV1(change.target.path);
  if (priorPrefix === null || replacementPrefix === null) return;
  if (relocation !== null) {
    await relocation.acceptFolderRename(
      priorPrefix,
      replacementPrefix,
      vaultId,
    );
    return;
  }
  const rekeys = registry.identitiesWithinPrefix(priorPrefix).map((prior) => ({
    prior,
    replacement: runtimeNoteIdentityV1(
      vaultId,
      `${replacementPrefix}${prior.vaultRelativeMarkdownPath.slice(priorPrefix.length)}`,
    ),
  }));
  await registry.rekeyBatch(rekeys);
}

export async function runRuntimeFileRelocationV1(options: {
  readonly initial: FileRelocationRecordV1;
  readonly ports: FileRelocationPortsV1;
  readonly recovery: RecoveryStore;
}): Promise<CommandResultV1<void>> {
  const loaded = await options.recovery.loadRelocationById({
    relocationId: options.initial.relocationId,
  });
  if (!loaded.ok) return loaded;
  if (loaded.value !== null && !isFileRecord(loaded.value)) {
    return commandFailure("sidecar-conflict");
  }
  return loaded.value === null
    ? beginFileRelocation(options.initial, options.recovery, options.ports)
    : resumeFileRelocation(loaded.value, options.recovery, options.ports);
}

function isFileRecord(
  value: FileRelocationRecordV1 | PrefixRelocationRecordV1,
): value is FileRelocationRecordV1 {
  return value.kind === "markdown-file" || value.kind === "sidecar-location";
}
