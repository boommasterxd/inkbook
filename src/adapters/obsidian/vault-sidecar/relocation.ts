import {
  commandFailure,
  commandSuccess,
  parseRelocationId,
  type CommandResultV1,
  type NoteIdentityV1,
  type RelocationId,
  type SettingsRevision,
} from "../../../application/note-session";
import type {
  FileRelocationRecordV1,
  PrefixRelocationMemberV1,
  PrefixRelocationPlanV1,
  PrefixRelocationRecordV1,
  SidecarBaseIdentityV1,
} from "../../../application/recovery";
import type { SidecarStorageLayoutV1 } from "../../../application/persistence";
import type { SceneRevision } from "../../../domain/model";
import { normalizeVaultRelativePathV1 } from "../../../application/vault-path";
import {
  isAbortRequested,
  isVaultFileCapability,
  isVaultFolderCapability,
  parentVaultPath,
  deriveSidecarPath,
  SIDECAR_SUFFIX,
  type NormalizeVaultPath,
  type VaultAbstractFileCapability,
  type VaultFileCapability,
  validateVaultRelativePath,
} from "./paths";

const MAX_CREATED_DESTINATION_FOLDERS = Number("32");
const MAX_DESTINATION_FOLDER_SEGMENTS = Number("64");

export interface SidecarRelocationVaultCapability {
  readonly normalizePath: NormalizeVaultPath;
  getFileByPath(path: string): VaultAbstractFileCapability | null;
  createFolder(path: string): Promise<void>;
  rename(file: VaultFileCapability, destinationPath: string): Promise<void>;
}

export interface SidecarRelocationRequest {
  readonly relocationId: RelocationId;
  readonly sourceFile: VaultFileCapability;
  readonly destinationPath: string;
}

export type SidecarRelocationResult =
  | {
      readonly kind: "acknowledged";
      readonly destinationFile: VaultFileCapability;
      readonly relocationId: RelocationId;
    }
  | { readonly kind: "cancelled" }
  | { readonly kind: "collision" }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "invalid-request" }
  | { readonly kind: "ownership-busy" }
  | { readonly kind: "resource-limit" }
  | { readonly kind: "stale-acknowledgement" }
  | { readonly kind: "wrong-file-kind" };

interface OwnedRenameEvent {
  readonly destinationPath: string;
  readonly oldPath: string;
  readonly relocationId: RelocationId;
}

function folderPaths(destinationPath: string): readonly string[] | null {
  const parentPath = parentVaultPath(destinationPath);
  if (parentPath.length === 0) return Object.freeze([]);
  const segments = parentPath.split("/");
  if (segments.length > MAX_DESTINATION_FOLDER_SEGMENTS) return null;
  const paths: string[] = [];
  let path = "";
  for (const segment of segments) {
    path = path.length === 0 ? segment : `${path}/${segment}`;
    paths.push(path);
  }
  return Object.freeze(paths);
}

export class VaultSidecarRelocator {
  private disposalGeneration = 0;
  private disposed = false;
  private ownedEvent: OwnedRenameEvent | null = null;

  public constructor(
    private readonly vault: SidecarRelocationVaultCapability,
  ) {}

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposalGeneration += 1;
    this.ownedEvent = null;
  }

  public consumeOwnedRenameEvent(
    oldPath: string,
    target: unknown,
  ): RelocationId | null {
    const owned = this.ownedEvent;
    if (
      owned === null ||
      !isVaultFileCapability(target) ||
      this.vault.getFileByPath(target.path) !== target ||
      target.path !== owned.destinationPath ||
      oldPath !== owned.oldPath
    ) {
      return null;
    }
    this.ownedEvent = null;
    return owned.relocationId;
  }

  public cancelEventOwnership(relocationId: RelocationId): boolean {
    if (this.ownedEvent?.relocationId !== relocationId) return false;
    this.ownedEvent = null;
    return true;
  }

  public async relocate(
    request: SidecarRelocationRequest,
    signal?: AbortSignal,
  ): Promise<SidecarRelocationResult> {
    if (this.disposed || isAbortRequested(signal)) return { kind: "cancelled" };
    if (this.ownedEvent !== null) return { kind: "ownership-busy" };
    const validated = this.validateRequest(request);
    if (validated === null) return { kind: "invalid-request" };
    const source = this.vault.getFileByPath(validated.sourceFile.path);
    if (!isVaultFileCapability(source) || source !== validated.sourceFile) {
      return { kind: "wrong-file-kind" };
    }
    const folderPathList = folderPaths(validated.destinationPath);
    if (folderPathList === null) return { kind: "resource-limit" };
    const folderAdmission = this.preflightFolders(folderPathList);
    if (folderAdmission !== "ready") return { kind: folderAdmission };
    const foldersReady = await this.createMissingFolders(
      folderPathList,
      signal,
    );
    if (foldersReady === "folder-create-failed") {
      return {
        kind: "failed",
        error: new Error("Destination folder creation failed."),
      };
    }
    if (foldersReady !== "ready") return { kind: foldersReady };
    return this.renameValidated(validated, signal);
  }

  private validateRequest(
    request: SidecarRelocationRequest,
  ): SidecarRelocationRequest | null {
    try {
      parseRelocationId(request.relocationId);
      const sourcePath = validateVaultRelativePath(
        request.sourceFile.path,
        this.vault.normalizePath,
        SIDECAR_SUFFIX,
      );
      const destinationPath = validateVaultRelativePath(
        request.destinationPath,
        this.vault.normalizePath,
        SIDECAR_SUFFIX,
      );
      if (sourcePath === destinationPath) return null;
      return Object.freeze({ ...request, destinationPath });
    } catch {
      return null;
    }
  }

  private preflightFolders(
    paths: readonly string[],
  ): "ready" | "resource-limit" | "wrong-file-kind" {
    let missing = 0;
    for (const path of paths) {
      const entry = this.vault.getFileByPath(path);
      if (entry === null) missing += 1;
      else if (!isVaultFolderCapability(entry)) return "wrong-file-kind";
      if (missing > MAX_CREATED_DESTINATION_FOLDERS) return "resource-limit";
    }
    return "ready";
  }

  private async createMissingFolders(
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<
    | "cancelled"
    | "folder-create-failed"
    | "ready"
    | "resource-limit"
    | "wrong-file-kind"
  > {
    let createdCount = 0;
    for (const path of paths) {
      if (this.disposed || isAbortRequested(signal)) return "cancelled";
      const current = this.vault.getFileByPath(path);
      if (current !== null) {
        if (!isVaultFolderCapability(current)) return "wrong-file-kind";
        continue;
      }
      createdCount += 1;
      if (createdCount > MAX_CREATED_DESTINATION_FOLDERS) {
        return "resource-limit";
      }
      try {
        await this.vault.createFolder(path);
      } catch {
        const raced = this.vault.getFileByPath(path);
        if (raced === null) return "folder-create-failed";
        if (!isVaultFolderCapability(raced)) return "wrong-file-kind";
      }
      const created = this.vault.getFileByPath(path);
      if (!isVaultFolderCapability(created) || created.path !== path) {
        return "wrong-file-kind";
      }
    }
    return "ready";
  }

  private async renameValidated(
    request: SidecarRelocationRequest,
    signal?: AbortSignal,
  ): Promise<SidecarRelocationResult> {
    if (this.disposed || isAbortRequested(signal)) return { kind: "cancelled" };
    const disposalGeneration = this.disposalGeneration;
    const oldPath = request.sourceFile.path;
    const source = this.vault.getFileByPath(oldPath);
    if (!isVaultFileCapability(source) || source !== request.sourceFile) {
      return { kind: "wrong-file-kind" };
    }
    if (this.vault.getFileByPath(request.destinationPath) !== null) {
      return { kind: "collision" };
    }
    this.ownedEvent = Object.freeze({
      destinationPath: request.destinationPath,
      oldPath,
      relocationId: request.relocationId,
    });
    try {
      await this.vault.rename(source, request.destinationPath);
    } catch (error) {
      this.cancelEventOwnership(request.relocationId);
      return this.vault.getFileByPath(request.destinationPath) === null
        ? { kind: "failed", error }
        : { kind: "collision" };
    }
    const destination = this.vault.getFileByPath(request.destinationPath);
    if (!isVaultFileCapability(destination)) {
      return { kind: "wrong-file-kind" };
    }
    if (
      this.disposalGeneration !== disposalGeneration ||
      isAbortRequested(signal)
    ) {
      return { kind: "stale-acknowledgement" };
    }
    return {
      kind: "acknowledged",
      destinationFile: destination,
      relocationId: request.relocationId,
    };
  }
}

export function runtimeMarkdownPathV1(path: string): string | null {
  try {
    return normalizeVaultRelativePathV1(path, { requiredSuffix: ".md" });
  } catch {
    return null;
  }
}

export function runtimeFolderPathV1(path: string): string | null {
  try {
    return normalizeVaultRelativePathV1(path);
  } catch {
    return null;
  }
}

export function runtimeNoteIdentityV1(
  vaultId: string,
  path: string,
): NoteIdentityV1 {
  return Object.freeze({
    vaultIdHint: vaultId,
    vaultRelativeMarkdownPath: path,
  });
}

export function sameRuntimeNoteIdentityV1(
  left: NoteIdentityV1,
  right: NoteIdentityV1,
): boolean {
  return (
    left.vaultIdHint === right.vaultIdHint &&
    left.vaultRelativeMarkdownPath === right.vaultRelativeMarkdownPath
  );
}

export function runtimePrefixRelocationRecordV1(
  input: Omit<PrefixRelocationRecordV1, "cursor" | "step">,
): PrefixRelocationRecordV1 {
  return { ...input, cursor: 0, step: "prepared" };
}

export function runtimePrefixRelocationPlanV1(
  record: PrefixRelocationRecordV1,
): PrefixRelocationPlanV1 {
  return Object.freeze({
    admittedRecordCount: record.admittedRecordCount,
    expectedSettingsRevision: record.expectedSettingsRevision,
    generation: record.generation,
    relocationId: record.relocationId,
  });
}

export interface RuntimeRelocationMemberInputV1 {
  readonly base: SidecarBaseIdentityV1;
  readonly identity: NoteIdentityV1;
  readonly layout: SidecarStorageLayoutV1 | null;
  readonly normalizePath: (path: string) => string;
  readonly ordinal: number;
  readonly replacement: NoteIdentityV1;
  readonly sceneRevision: SceneRevision;
}

export function runtimeRelocationMemberV1(
  input: RuntimeRelocationMemberInputV1,
): PrefixRelocationMemberV1 {
  const destination =
    input.layout === null
      ? input.base.vaultRelativePath
      : deriveSidecarPath(
          input.replacement.vaultRelativeMarkdownPath,
          input.layout,
          input.normalizePath,
        );
  return Object.freeze({
    destinationSidecarPath: destination,
    expectedSceneRevision: input.sceneRevision,
    ordinal: input.ordinal,
    priorNoteIdentity: input.identity,
    replacementNoteIdentity: input.replacement,
    sidecarBase: input.base,
    sourceSidecarPath: input.base.vaultRelativePath,
  });
}

export function runtimeFileRelocationRecordV1(
  member: PrefixRelocationMemberV1,
  relocationId: RelocationId,
  expectedSettingsRevision: SettingsRevision,
): FileRelocationRecordV1 {
  const base = member.sidecarBase;
  const sourceSidecarPath = member.sourceSidecarPath;
  const destinationSidecarPath = member.destinationSidecarPath;
  const expectedSceneRevision = member.expectedSceneRevision;
  if (
    base === null ||
    sourceSidecarPath === null ||
    destinationSidecarPath === null ||
    expectedSceneRevision === null
  )
    throw new TypeError("Relocation member is incomplete.");
  return {
    destinationMarkdownPath:
      member.replacementNoteIdentity.vaultRelativeMarkdownPath,
    destinationSidecarPath,
    expectedSceneRevision,
    expectedSettingsRevision,
    kind: "markdown-file",
    noteIdentity: member.priorNoteIdentity,
    relocationId,
    sidecarBase: base,
    sourceMarkdownPath: member.priorNoteIdentity.vaultRelativeMarkdownPath,
    sourceSidecarPath,
    step: "prepared",
  };
}

export async function settleRuntimeSidecarMoveV1(options: {
  readonly file: VaultFileCapability | null;
  readonly flush: () => Promise<"failed" | "flushed">;
  readonly record: FileRelocationRecordV1;
  readonly relocator: VaultSidecarRelocator;
  readonly updateFile: (file: VaultFileCapability) => void;
}): Promise<CommandResultV1<void>> {
  if ((await options.flush()) !== "flushed") {
    return commandFailure("relocation-pending");
  }
  if (options.record.sidecarBase.revision === null) {
    return commandSuccess(undefined);
  }
  const file = options.file;
  if (file === null) return commandFailure("sidecar-conflict");
  if (file.path === options.record.destinationSidecarPath) {
    return commandSuccess(undefined);
  }
  const moved = await options.relocator.relocate({
    destinationPath: options.record.destinationSidecarPath,
    relocationId: options.record.relocationId,
    sourceFile: file,
  });
  if (moved.kind !== "acknowledged") {
    return commandFailure(
      moved.kind === "resource-limit" ? "resource-limit" : "sidecar-conflict",
    );
  }
  options.updateFile(moved.destinationFile);
  return commandSuccess(undefined);
}
