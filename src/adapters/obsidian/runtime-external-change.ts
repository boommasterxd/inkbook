import {
  commandFailure,
  commandSuccess,
  createSidecarRevision,
  type CommandResultV1,
  type NoteIdentityV1,
  type RelocationId,
  type Sha256Digest,
} from "../../application/note-session";
import {
  createPersistenceParseWorkV1,
  PersistenceDecodedBytePoolV1,
  SIDECAR_RESOURCE_LIMITS_V1,
  type InkbookSidecarV1,
  type PersistenceCodecPortV1,
} from "../../application/persistence";
import {
  ExternalSidecarChangeCoordinatorV1,
  type ConflictCopyRequestV1,
  type ExternalConflictChoiceV1,
  type ExternalSidecarConflictV1,
  type ExternalSidecarDecisionV1,
  type ExternalSidecarDriftV1,
  type ExternalSidecarObservationV1,
  type ExternalSidecarPortsV1,
  type ExternalReloadPreparationV1,
} from "../../application/persistence/external-change";
import {
  sameSidecarBase,
  type FileRelocationRecordV1,
  type RecoveryLoadRequestV1,
  type RecoveryStore,
  type SidecarBaseIdentityV1,
} from "../../application/recovery";
import type { SourceDigestWorkPortV1 } from "../../application/source-coordination/work-ports";
import {
  hasRuntimeConflictCopyCapacityV1,
  RUNTIME_CONFLICT_COPY_LIMIT_V1,
} from "./runtime-external-conflict-copy";
import { digestRuntimeExternalTextV1 } from "./runtime-external-digest";
import type { ObsidianVaultChangeV1 } from "./vault-sidecar/host-events";
import { classifyVaultSidecarEvent } from "./vault-sidecar/events";
import {
  isVaultFileCapability,
  requireVaultFile,
  validateVaultRelativePath,
  type VaultFileCapability,
} from "./vault-sidecar/paths";
import {
  isPreparedSidecarWriteValid,
  type PreparedSidecarWrite,
  type SidecarVaultCapability,
} from "./vault-sidecar/repository";
const UTF16_BYTES_PER_UNIT = 2;
type AsyncResult = Promise<CommandResultV1<void>>;
export interface RuntimeExternalChangeContextV1 {
  readonly activeRelocation: FileRelocationRecordV1 | null;
  readonly expectedBase: SidecarBaseIdentityV1;
  readonly noteIdentity: NoteIdentityV1;
  readonly recoveryLoadRequest: RecoveryLoadRequestV1;
}
export interface RuntimeExternalReloadV1 {
  readonly base: SidecarBaseIdentityV1;
  readonly file: VaultFileCapability;
  readonly rawText: string;
  readonly sidecar: InkbookSidecarV1;
}
interface RuntimeExternalChangePortsV1 {
  consumeOwnedWrite(base: SidecarBaseIdentityV1): boolean;
  readContext(): RuntimeExternalChangeContextV1 | null;
  publishConflict(conflict: ExternalSidecarConflictV1): AsyncResult;
  publishMissingDrift(drift: ExternalSidecarDriftV1): AsyncResult;
  publishReload(reload: RuntimeExternalReloadV1): AsyncResult;
  publishUnreadableConflict(base: SidecarBaseIdentityV1): AsyncResult;
  prepareLocalConflictCopy(
    conflict: ExternalSidecarConflictV1,
  ): Promise<CommandResultV1<PreparedSidecarWrite>>;
  remainReadOnly(conflict: ExternalSidecarConflictV1): AsyncResult;
}
export interface RuntimeExternalChangeVaultV1 extends SidecarVaultCapability {
  getFiles(): readonly unknown[];
}
export interface RuntimeExternalChangeBindingConfigV1 {
  readonly externalVault?: RuntimeExternalChangeVaultV1;
  readonly persistenceCodecPort: PersistenceCodecPortV1;
  readonly recovery: RecoveryStore;
  readonly sourceDigestWorkPort: SourceDigestWorkPortV1;
}
export interface RuntimeExternalChangeBindingPortsV1 extends RuntimeExternalChangePortsV1 {
  readonly decodedBytes: PersistenceDecodedBytePoolV1;
}
type BoundExternalChangeConfigV1 = RuntimeExternalChangeBindingConfigV1 & {
  readonly externalVault: RuntimeExternalChangeVaultV1;
};
export function bindRuntimeExternalSidecarChangeV1(
  config: RuntimeExternalChangeBindingConfigV1,
  ports: RuntimeExternalChangeBindingPortsV1,
): RuntimeExternalSidecarChangeV1 | null {
  const externalVault = config.externalVault;
  if (externalVault === undefined) return null;
  return new RuntimeExternalSidecarChangeV1(
    { ...config, externalVault },
    ports,
  );
}
type LoadResultV1 =
  | { readonly kind: "loaded"; readonly value: RuntimeExternalReloadV1 }
  | { readonly kind: "disposed" | "resource-limit" | "sidecar-conflict" };
export class RuntimeExternalSidecarChangeV1 {
  readonly #config: BoundExternalChangeConfigV1;
  readonly #ports: RuntimeExternalChangeBindingPortsV1;
  readonly #coordinator: ExternalSidecarChangeCoordinatorV1;
  readonly #activeCancels = new Set<() => void>();
  #disposed = false;
  #nextReloadToken = 0;
  #pendingConflict: ExternalSidecarConflictV1 | null = null;
  #preparedReload: {
    readonly load: RuntimeExternalReloadV1;
    readonly token: string;
  } | null = null;
  #tail: Promise<void> = Promise.resolve();

  public constructor(
    config: BoundExternalChangeConfigV1,
    ports: RuntimeExternalChangeBindingPortsV1,
  ) {
    this.#config = config;
    this.#ports = ports;
    this.#coordinator = new ExternalSidecarChangeCoordinatorV1(
      config.recovery,
      this.#coordinatorPorts(),
    );
  }

  public get pendingConflict(): ExternalSidecarConflictV1 | null {
    return this.#pendingConflict;
  }

  public accept(
    change: ObsidianVaultChangeV1,
    ownedRelocationId: RelocationId | null = null,
  ): Promise<CommandResultV1<ExternalSidecarDecisionV1>> {
    return this.#serialize(() => this.#observe(change, ownedRelocationId));
  }

  public resolve(choice: ExternalConflictChoiceV1): AsyncResult {
    return this.#serialize(async () => {
      const conflict = this.#pendingConflict;
      if (conflict === null) return commandFailure("invalid-command");
      const result = await this.#coordinator.resolve(conflict, choice);
      if (result.ok && choice.kind !== "cancel-read-only") {
        this.#pendingConflict = null;
        this.#preparedReload = null;
      }
      return result;
    });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const cancel of this.#activeCancels) cancel();
    this.#activeCancels.clear();
    this.#pendingConflict = null;
    this.#preparedReload = null;
  }

  async #observe(
    change: ObsidianVaultChangeV1,
    ownedRelocationId: RelocationId | null,
  ): Promise<CommandResultV1<ExternalSidecarDecisionV1>> {
    if (this.#isDisposed()) return commandFailure("disposed");
    const context = this.#ports.readContext();
    if (context === null) return commandFailure("sidecar-drift");
    const classified = classifyVaultSidecarEvent(
      {
        markdownPath: context.noteIdentity.vaultRelativeMarkdownPath,
        sidecarPath: context.expectedBase.vaultRelativePath,
      },
      change,
    );
    if (classified.kind === "sidecar-write") {
      return this.#observeWrite(context, classified.eventKind, change.target);
    }
    if (classified.kind === "marker-present-sidecar-missing") {
      return this.#observeMissing(
        context,
        change,
        classified.movedPath,
        ownedRelocationId,
      );
    }
    if (
      classified.kind === "folder-path-change" &&
      change.kind === "delete" &&
      classified.sidecarAffected
    ) {
      return this.#coordinator.observe({
        ...context,
        event: {
          kind: "delete",
          path: context.expectedBase.vaultRelativePath,
        },
      });
    }
    if (
      classified.kind === "invalid-path" ||
      classified.kind === "wrong-file-kind"
    ) {
      return commandFailure("invalid-command");
    }
    return commandSuccess({ kind: "unrelated" });
  }

  #observeMissing(
    context: RuntimeExternalChangeContextV1,
    change: ObsidianVaultChangeV1,
    movedPath: string | null,
    ownedRelocationId: RelocationId | null,
  ): Promise<CommandResultV1<ExternalSidecarDecisionV1>> {
    return this.#coordinator.observe({
      ...context,
      event:
        change.kind === "rename" && movedPath !== null
          ? {
              kind: "rename",
              newPath: movedPath,
              oldPath: change.oldPath,
              ownedRelocationId,
            }
          : {
              kind: "delete",
              path: context.expectedBase.vaultRelativePath,
            },
    });
  }

  async #observeWrite(
    context: RuntimeExternalChangeContextV1,
    kind: "create" | "modify",
    target: { readonly path: string },
  ): Promise<CommandResultV1<ExternalSidecarDecisionV1>> {
    if (target.path !== context.expectedBase.vaultRelativePath) {
      return commandSuccess({ kind: "unrelated" });
    }
    if (!isVaultFileCapability(target)) {
      return this.#unreadable(context.expectedBase, "sidecar-conflict");
    }
    const loaded = await this.#load(target, context);
    if (loaded.kind !== "loaded") {
      return this.#unreadable(context.expectedBase, loaded.kind);
    }
    if (this.#ports.consumeOwnedWrite(loaded.value.base)) {
      return commandSuccess({ kind: "current" });
    }
    const observation: ExternalSidecarObservationV1 = {
      ...context,
      event: {
        kind,
        observedBase: loaded.value.base,
        path: target.path,
      },
    };
    return this.#coordinator.observe(observation);
  }

  async #load(
    file: VaultFileCapability,
    context: RuntimeExternalChangeContextV1,
  ): Promise<LoadResultV1> {
    if (file.stat.size > SIDECAR_RESOURCE_LIMITS_V1.maxUtf8Bytes) {
      return { kind: "resource-limit" };
    }
    if (this.#config.externalVault.getFileByPath(file.path) !== file) {
      return { kind: "sidecar-conflict" };
    }
    let rawText: string;
    try {
      rawText = await this.#config.externalVault.cachedRead(file);
    } catch {
      return { kind: "sidecar-conflict" };
    }
    if (
      this.#disposed ||
      rawText.length > SIDECAR_RESOURCE_LIMITS_V1.maxUtf8Bytes
    ) {
      return { kind: this.#disposed ? "disposed" : "resource-limit" };
    }
    return this.#parseAndIdentify(file, rawText, context);
  }

  async #parseAndIdentify(
    file: VaultFileCapability,
    rawText: string,
    context: RuntimeExternalChangeContextV1,
  ): Promise<LoadResultV1> {
    const decodedBytes = this.#ports.decodedBytes.tryAcquire(
      Math.max(1, rawText.length * UTF16_BYTES_PER_UNIT),
    );
    if (decodedBytes === null) return { kind: "resource-limit" };
    let cancelParse = (): void => undefined;
    try {
      const parse = this.#config.persistenceCodecPort.submit(
        createPersistenceParseWorkV1(rawText, file.stat.size, decodedBytes),
      );
      cancelParse = (): void => parse.cancel();
      this.#activeCancels.add(cancelParse);
      const [parsed, digest] = await Promise.all([
        parse.result,
        digestRuntimeExternalTextV1({
          expectedBytes: file.stat.size,
          rawText,
          registerCancel: (cancel) => this.#activeCancels.add(cancel),
          releaseCancel: (cancel) => this.#activeCancels.delete(cancel),
          workPort: this.#config.sourceDigestWorkPort,
        }),
      ]);
      if (
        this.#disposed ||
        parsed.kind !== "parsed-sidecar" ||
        parsed.value.kind !== "current" ||
        digest === null
      ) {
        return { kind: this.#disposed ? "disposed" : "sidecar-conflict" };
      }
      return this.#identify(
        file,
        rawText,
        parsed.value.sidecar,
        digest,
        context,
      );
    } catch {
      cancelParse();
      return { kind: this.#disposed ? "disposed" : "sidecar-conflict" };
    } finally {
      this.#activeCancels.delete(cancelParse);
      decodedBytes.release();
    }
  }

  #identify(
    file: VaultFileCapability,
    rawText: string,
    sidecar: InkbookSidecarV1,
    digest: Sha256Digest,
    context: RuntimeExternalChangeContextV1,
  ): LoadResultV1 {
    if (
      sidecar.noteIdentity.vaultRelativeMarkdownPath !==
        context.noteIdentity.vaultRelativeMarkdownPath ||
      sidecar.noteIdentity.markdownContentDigest !==
        context.recoveryLoadRequest.currentMarkdownDigest
    ) {
      return { kind: "sidecar-conflict" };
    }
    return {
      kind: "loaded",
      value: Object.freeze({
        base: Object.freeze({
          markdownPath: context.noteIdentity.vaultRelativeMarkdownPath,
          rawTextSha256: digest,
          revision: createSidecarRevision(sidecar.revision),
          vaultRelativePath: file.path,
        }),
        file,
        rawText,
        sidecar,
      }),
    };
  }

  #coordinatorPorts(): ExternalSidecarPortsV1 {
    return {
      createConflictCopyIfAbsent: (request) => this.#createCopy(request),
      prepareExternalReload: (conflict) => this.#prepareReload(conflict),
      publishConflict: async (conflict): AsyncResult => {
        const result = await this.#ports.publishConflict(conflict);
        if (result.ok) this.#pendingConflict = conflict;
        return result;
      },
      publishExternalReload: async (_conflict, preparation): AsyncResult => {
        const prepared = this.#preparedReload;
        if (prepared?.token !== preparation.token) {
          return commandFailure("sidecar-conflict");
        }
        return this.#ports.publishReload(prepared.load);
      },
      publishMissingDrift: (drift) => this.#ports.publishMissingDrift(drift),
      remainReadOnly: (conflict) => this.#ports.remainReadOnly(conflict),
    };
  }

  async #prepareReload(
    conflict: ExternalSidecarConflictV1,
  ): Promise<CommandResultV1<ExternalReloadPreparationV1>> {
    const context = this.#ports.readContext();
    if (
      context === null ||
      !sameSidecarBase(context.expectedBase, conflict.expectedBase)
    ) {
      return commandFailure("sidecar-conflict");
    }
    const target = this.#config.externalVault.getFileByPath(
      conflict.observedBase.vaultRelativePath,
    );
    if (!isVaultFileCapability(target)) {
      return commandFailure("sidecar-conflict");
    }
    const loaded = await this.#load(target, context);
    if (
      loaded.kind !== "loaded" ||
      !sameSidecarBase(loaded.value.base, conflict.observedBase)
    ) {
      return commandFailure("sidecar-conflict");
    }
    const token = `external-reload-${String(++this.#nextReloadToken)}`;
    this.#preparedReload = { load: loaded.value, token };
    return commandSuccess({ token, validatedExternalBase: loaded.value.base });
  }

  async #createCopy(request: ConflictCopyRequestV1): AsyncResult {
    if (this.#isDisposed()) return commandFailure("disposed");
    if (request.maximumExistingCopies !== RUNTIME_CONFLICT_COPY_LIMIT_V1) {
      return commandFailure("invalid-command");
    }
    const destination = validateVaultRelativePath(
      request.destinationPath,
      this.#config.externalVault.normalizePath,
    );
    if (destination !== request.destinationPath) {
      return commandFailure("invalid-command");
    }
    if (
      !hasRuntimeConflictCopyCapacityV1(
        this.#config.externalVault.getFiles(),
        request.conflict,
      )
    ) {
      return commandFailure("sidecar-conflict");
    }
    if (this.#config.externalVault.getFileByPath(destination) !== null) {
      return commandFailure("sidecar-conflict");
    }
    const prepared = await this.#ports.prepareLocalConflictCopy(
      request.conflict,
    );
    if (!prepared.ok) return prepared;
    if (!isPreparedSidecarWriteValid(prepared.value)) {
      return commandFailure("resource-limit");
    }
    if (this.#isDisposed()) return commandFailure("disposed");
    try {
      const created = await this.#config.externalVault.create(
        destination,
        prepared.value.rawText,
      );
      requireVaultFile(created, destination);
      return this.#isDisposed()
        ? commandFailure("disposed")
        : commandSuccess(undefined);
    } catch {
      return commandFailure("sidecar-conflict");
    }
  }

  async #unreadable(
    base: SidecarBaseIdentityV1,
    kind: LoadResultV1["kind"],
  ): Promise<CommandResultV1<ExternalSidecarDecisionV1>> {
    if (kind === "disposed") return commandFailure("disposed");
    const published = await this.#ports.publishUnreadableConflict(base);
    if (!published.ok) return published;
    const code =
      kind === "resource-limit" ? "resource-limit" : "sidecar-conflict";
    return commandFailure(code);
  }

  #serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(action, action);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #isDisposed(): boolean {
    return this.#disposed;
  }
}
