import {
  commandFailure,
  commandSuccess,
  deriveRelocationIdV1,
  type CommandResultV1,
  type NoteIdentityV1,
  type NoteSessionRegistryV1,
  type RelocationId,
  type SettingsRevision,
} from "../../application/note-session";
import {
  beginPrefixRelocation,
  deriveRelocatedStorageRootV1,
  resumePrefixRelocation,
  type FileRelocationPortsV1,
  type PrefixRelocationPortsV1,
  type SidecarStorageLayoutV1,
  type SidecarStoragePolicyStoreV1,
  type PrefixRelocationRuleV1,
} from "../../application/persistence";
import type {
  FileRelocationRecordV1,
  PrefixRelocationMemberV1,
  PrefixRelocationRecordV1,
  RecoveryStore,
} from "../../application/recovery";
import type { VaultFileCapability } from "./vault-sidecar/paths";
import {
  runtimePrefixRelocationPlanV1,
  runtimePrefixRelocationRecordV1,
  runtimeFileRelocationRecordV1,
  sameRuntimeNoteIdentityV1,
  type VaultSidecarRelocator,
} from "./vault-sidecar/relocation";
import type { SidecarMarkerWriter } from "./vault-sidecar/marker";
import type { RuntimePersistenceV1 } from "./runtime-persistence";
import type { RuntimeSidecarResolutionV1 } from "./runtime-persistence-open";
import { resolveRuntimeRelocatedSidecarV1 } from "./runtime-persistence-open";
import type { ObsidianVaultChangeV1 } from "./vault-sidecar/host-events";
import {
  runRuntimeFileRelocationV1,
  RuntimeRelocationGateV1,
} from "./runtime-relocation-gate";

const RETAINED_PREFIX_LIMIT = Number("128");

export interface RuntimeRelocationControllerConfigV1 {
  readonly createRelocationId: () => RelocationId;
  readonly marker: SidecarMarkerWriter;
  readonly owners: () => readonly RuntimePersistenceV1[];
  readonly publishRelocationState: (
    owner: RuntimePersistenceV1,
    relocationId: RelocationId | null,
  ) => Promise<CommandResultV1<void>>;
  readonly readSettingsRevision: () => SettingsRevision;
  readonly recovery: RecoveryStore;
  readonly registry: NoteSessionRegistryV1;
  readonly relocator: VaultSidecarRelocator;
  readonly resolveMarkdownFile: (path: string) => VaultFileCapability | null;
  readonly storagePolicy: SidecarStoragePolicyStoreV1;
}

export class RuntimeRelocationControllerV1 {
  readonly #config: RuntimeRelocationControllerConfigV1;
  readonly #gate: RuntimeRelocationGateV1;
  #tail: Promise<void> = Promise.resolve();
  #nextGeneration: number | null = null;
  #rules: readonly PrefixRelocationRuleV1[] | null = null;
  #activeStorageRoot: PrefixRelocationRecordV1 | null = null;

  public constructor(config: RuntimeRelocationControllerConfigV1) {
    this.#config = config;
    this.#gate = new RuntimeRelocationGateV1({
      publish: config.publishRelocationState,
      registry: config.registry,
    });
  }

  public get activeStorageRootRelocation(): PrefixRelocationRecordV1 | null {
    return this.#activeStorageRoot;
  }

  public isRelocating(owner: RuntimePersistenceV1): boolean {
    return this.#gate.isActive(owner);
  }

  public consumeOwnedSidecarRename(
    change: Extract<ObsidianVaultChangeV1, { readonly kind: "rename" }>,
  ): RelocationId | null {
    return this.#config.relocator.consumeOwnedRenameEvent(
      change.oldPath,
      change.target,
    );
  }

  public maintenancePorts(): FileRelocationPortsV1 {
    return this.#gate.maintenancePorts(
      (identity) => this.#findOwner(identity),
      (owner) => this.#filePorts(owner),
    );
  }

  public resumeActive(): Promise<void> {
    return this.#enqueue(async () => {
      if (!(await this.#loadGeneration())) return;
      const active = await this.#config.recovery.loadActivePrefixRelocations({
        limit: RETAINED_PREFIX_LIMIT,
      });
      if (!active.ok) return;
      for (const record of active.value) {
        if (this.#nextGeneration !== null)
          this.#nextGeneration = Math.max(
            this.#nextGeneration,
            record.generation + 1,
          );
        if (record.kind === "storage-root") this.#activeStorageRoot = record;
        if (await this.#resumePrefix(record)) this.#clearActiveRoot(record);
      }
    });
  }

  public async dispose(): Promise<void> {
    await this.#tail;
    this.#config.marker.dispose();
    this.#config.relocator.dispose();
  }

  public resolveSidecar(
    identity: NoteIdentityV1,
    resolution: RuntimeSidecarResolutionV1,
    policy: import("../../application/persistence").SidecarStoragePolicyV1,
    getFile: (path: string) => VaultFileCapability | null,
  ): RuntimeSidecarResolutionV1 {
    return resolveRuntimeRelocatedSidecarV1({
      getFile,
      identity,
      policy,
      resolution,
      rules: this.#rules,
    });
  }

  public acceptFileRename(
    prior: NoteIdentityV1,
    replacement: NoteIdentityV1,
  ): Promise<void> {
    return this.#enqueue(async () => {
      const owner = this.#findOwner(prior, replacement);
      if (owner === undefined) return;
      const member = owner.relocationMember(replacement, 0);
      if (member === null) return;
      if (member.sidecarBase === null) return;
      const record = runtimeFileRelocationRecordV1(
        member,
        this.#config.createRelocationId(),
        this.#config.readSettingsRevision(),
      );
      if (!(await this.#gate.activate(owner, prior, record.relocationId)))
        return;
      await this.#runFile(record, owner);
    });
  }

  public acceptFolderRename(
    priorPrefix: string,
    replacementPrefix: string,
    vaultId: string,
  ): Promise<void> {
    return this.#enqueue(async () => {
      if (!(await this.#loadGeneration()) || this.#nextGeneration === null)
        return;
      let kind: PrefixRelocationRecordV1["kind"] = "folder-prefix";
      let replacementLayout: SidecarStorageLayoutV1 | null = null;
      const policy = this.#config.storagePolicy.snapshot.policy;
      if (policy.mode === "vault-root") {
        const derived = deriveRelocatedStorageRootV1({
          currentRoot: policy.vaultRelativeRoot,
          priorPrefix,
          replacementPrefix,
        });
        if (!derived.ok) return;
        if (derived.value.kind === "replacement") {
          kind = "storage-root";
          replacementLayout = {
            kind: "vault-root",
            vaultRelativeRoot: derived.value.vaultRelativeRoot,
          };
        }
      }
      const identities =
        this.#config.registry.identitiesWithinPrefix(priorPrefix);
      const members: PrefixRelocationMemberV1[] = [];
      const owners: RuntimePersistenceV1[] = [];
      for (const [ordinal, prior] of identities.entries()) {
        const replacement = Object.freeze({
          vaultIdHint: vaultId,
          vaultRelativeMarkdownPath: `${replacementPrefix}${prior.vaultRelativeMarkdownPath.slice(priorPrefix.length)}`,
        });
        const owner = this.#findOwner(prior);
        if (owner === undefined) return;
        const member = owner.relocationMember(
          replacement,
          ordinal,
          replacementLayout ?? undefined,
        );
        if (member === null) return;
        members.push(member);
        owners.push(owner);
      }
      const record = runtimePrefixRelocationRecordV1({
        admittedRecordCount: members.length,
        expectedSettingsRevision: this.#config.readSettingsRevision(),
        generation: this.#nextGeneration,
        kind,
        priorPrefix,
        relocationId: this.#config.createRelocationId(),
        replacementPrefix,
      });
      const ports = this.#prefixPorts(members);
      for (const [index, owner] of owners.entries()) {
        const identity = members[index]?.priorNoteIdentity;
        if (
          identity === undefined ||
          !(await this.#gate.activate(owner, identity, record.relocationId))
        ) {
          return;
        }
      }
      this.#gate.retainPrefix(record.relocationId, new Set(owners));
      const started =
        kind === "storage-root"
          ? await this.#beginStorageRoot(record, members, ports)
          : await beginPrefixRelocation(
              record,
              Number("512"),
              this.#config.recovery,
              ports,
            );
      if (started.ok) {
        this.#nextGeneration += 1;
        if (await this.#resumePrefix(started.value))
          this.#clearActiveRoot(record);
      }
    });
  }

  async #loadGeneration(): Promise<boolean> {
    if (this.#nextGeneration !== null) return true;
    return this.#refreshRules();
  }

  async #refreshRules(): Promise<boolean> {
    const rules = await this.#config.recovery.loadRetainedPrefixRelocationRules(
      { limit: RETAINED_PREFIX_LIMIT },
    );
    if (!rules.ok) {
      this.#rules = null;
      return false;
    }
    this.#rules = rules.value.map((rule) => ({
      generation: rule.generation,
      priorPrefix: rule.priorPrefix,
      relocationId: rule.relocationId,
      replacementPrefix: rule.replacementPrefix,
    }));
    this.#nextGeneration =
      rules.value.length >= RETAINED_PREFIX_LIMIT
        ? null
        : (rules.value.at(Number("-1"))?.generation ?? 0) + 1;
    return true;
  }

  #enqueue(action: () => Promise<void>): Promise<void> {
    const run = this.#tail.then(action, action);
    this.#tail = run;
    return run;
  }

  async #resumePrefix(record: PrefixRelocationRecordV1): Promise<boolean> {
    if (!(await this.#ensurePrefixOwners(record))) return false;
    if (
      record.kind === "storage-root" &&
      !(await this.#ensureRootPolicy(record))
    )
      return false;
    let current = record;
    for (let batch = 0; batch < Number("9"); batch += 1) {
      const resumed = await resumePrefixRelocation(
        current,
        Number("512"),
        this.#config.recovery,
        this.#prefixPorts(),
      );
      if (!resumed.ok) return false;
      current = resumed.value;
      if (current.step === "complete") {
        await this.#refreshRules();
        return true;
      }
    }
    return false;
  }

  async #beginStorageRoot(
    record: PrefixRelocationRecordV1,
    members: readonly PrefixRelocationMemberV1[],
    ports: PrefixRelocationPortsV1,
  ): Promise<CommandResultV1<PrefixRelocationRecordV1>> {
    const started = await this.#config.recovery.beginRelocation(record);
    if (!started.ok) return started;
    this.#activeStorageRoot = record;
    const prepared = await this.#config.recovery.preparePrefixRelocationPlan({
      expectedPrefixRecord: record,
      members,
    });
    if (!prepared.ok || !(await this.#ensureRootPolicy(record))) {
      return commandFailure("relocation-pending");
    }
    return resumePrefixRelocation(
      record,
      Number("512"),
      this.#config.recovery,
      ports,
    );
  }

  async #ensureRootPolicy(record: PrefixRelocationRecordV1): Promise<boolean> {
    const policy = this.#config.storagePolicy.snapshot.policy;
    if (policy.mode !== "vault-root") return false;
    const derived = deriveRelocatedStorageRootV1({
      currentRoot: policy.vaultRelativeRoot,
      priorPrefix: record.priorPrefix,
      replacementPrefix: record.replacementPrefix,
    });
    if (!derived.ok) return false;
    if (derived.value.kind === "not-affected") {
      const reverse = deriveRelocatedStorageRootV1({
        currentRoot: policy.vaultRelativeRoot,
        priorPrefix: record.replacementPrefix,
        replacementPrefix: record.priorPrefix,
      });
      return reverse.ok && reverse.value.kind === "replacement";
    }
    const written = await this.#config.storagePolicy.setPolicy({
      mode: "vault-root",
      vaultRelativeRoot: derived.value.vaultRelativeRoot,
      version: 1,
    });
    return written.status === "acknowledged";
  }

  #clearActiveRoot(record: PrefixRelocationRecordV1): void {
    if (this.#activeStorageRoot?.relocationId === record.relocationId)
      this.#activeStorageRoot = null;
  }

  #prefixPorts(
    prepared?: readonly PrefixRelocationMemberV1[],
  ): PrefixRelocationPortsV1 {
    return {
      admitMutations: (record) => this.#gate.finishPrefix(record.relocationId),
      loadOrPrepareDurablePlan: (record) =>
        prepared === undefined
          ? Promise.resolve(
              commandSuccess(runtimePrefixRelocationPlanV1(record)),
            )
          : this.#config.recovery.preparePrefixRelocationPlan({
              expectedPrefixRecord: record,
              members: prepared,
            }),
      processPlannedEntry: async (
        record,
        _plan,
        ordinal,
      ): Promise<CommandResultV1<void>> => {
        const loaded = await this.#config.recovery.loadPrefixRelocationMember({
          ordinal,
          relocationId: record.relocationId,
        });
        if (!loaded.ok || loaded.value.sidecarBase === null) {
          return commandFailure("relocation-pending");
        }
        const owner = this.#findOwner(
          loaded.value.priorNoteIdentity,
          loaded.value.replacementNoteIdentity,
        );
        if (owner === undefined) return commandFailure("relocation-pending");
        return this.#runFile(
          runtimeFileRelocationRecordV1(
            loaded.value,
            await deriveRelocationIdV1(record.relocationId, ordinal),
            record.expectedSettingsRevision,
          ),
          owner,
        );
      },
    };
  }

  async #runFile(
    initial: FileRelocationRecordV1,
    owner: RuntimePersistenceV1,
  ): Promise<CommandResultV1<void>> {
    owner.setActiveRelocation(initial);
    const result = await runRuntimeFileRelocationV1({
      initial,
      ports: this.#filePorts(owner),
      recovery: this.#config.recovery,
    });
    if (result.ok) owner.setActiveRelocation(null);
    return result;
  }

  #filePorts(owner: RuntimePersistenceV1): FileRelocationPortsV1 {
    return {
      admitMutations: (record) => this.#gate.finishFile(owner, record),
      awaitSourceCheckpoint: () => owner.awaitRelocationCheckpoint(),
      rekeyOwnedIdentities: async (record): Promise<CommandResultV1<void>> => {
        const prior = Object.freeze({
          vaultIdHint: record.noteIdentity.vaultIdHint,
          vaultRelativeMarkdownPath: record.sourceMarkdownPath,
        });
        const rekeyed = await this.#config.registry.rekey(
          prior,
          record.noteIdentity,
        );
        if (rekeyed.ok) owner.rekeyPersistence(record);
        return rekeyed;
      },
      saveMarker: (record) => this.#saveMarker(record),
      saveSidecarMetadata: () => owner.saveRelocatedMetadata(),
      settleSaveAndMoveSidecar: (record) =>
        owner.settleAndMoveSidecar(record, this.#config.relocator),
    };
  }

  async #ensurePrefixOwners(
    record: PrefixRelocationRecordV1,
  ): Promise<boolean> {
    return this.#gate.ensurePrefix(
      record,
      this.#config.recovery,
      (first, second) => this.#findOwner(first, second),
    );
  }

  async #saveMarker(
    record: FileRelocationRecordV1,
  ): Promise<CommandResultV1<void>> {
    if (record.sidecarBase.revision === null) return commandSuccess(undefined);
    const note = this.#config.resolveMarkdownFile(
      record.destinationMarkdownPath,
    );
    if (note === null) return commandFailure("sidecar-conflict");
    const result = await this.#config.marker.compareAndSetLocator(
      note,
      record.sourceSidecarPath,
      record.destinationSidecarPath,
    );
    return result.kind === "acknowledged"
      ? commandSuccess(undefined)
      : commandFailure("sidecar-conflict");
  }

  #findOwner(
    first: NoteIdentityV1,
    second?: NoteIdentityV1,
  ): RuntimePersistenceV1 | undefined {
    return this.#config.owners().find((owner) => {
      const identity = owner.relocationMember(first, 0)?.priorNoteIdentity;
      return (
        (identity !== undefined &&
          sameRuntimeNoteIdentityV1(identity, first)) ||
        (identity !== undefined &&
          second !== undefined &&
          sameRuntimeNoteIdentityV1(identity, second))
      );
    });
  }
}
