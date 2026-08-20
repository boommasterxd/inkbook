import { isValidVaultRelativePathV1 } from "../../../application/vault-path";
import {
  isHiddenVaultPath,
  isAbortRequested,
  isVaultFileCapability,
  isVaultFolderCapability,
  SIDECAR_SUFFIX,
  type VaultAbstractFileCapability,
  type VaultFileCapability,
} from "./paths";

const ORPHAN_CANDIDATE_LIMIT = Number("10000");
const REVIEW_INSPECTION_SLICE = Number("512");
const REVIEW_TIME_SLICE_MS = Number("4");

export interface OpenSidecarIdentity {
  readonly markdownPath: string;
  readonly sidecarPath: string;
}

export type VaultSidecarEvent =
  | {
      readonly kind: "create" | "delete" | "modify";
      readonly target: unknown;
    }
  | {
      readonly kind: "rename";
      readonly oldPath: string;
      readonly target: unknown;
    };

export type VaultSidecarEventClassification =
  | { readonly kind: "sidecar-write"; readonly eventKind: "create" | "modify" }
  | {
      readonly kind: "marker-present-sidecar-missing";
      readonly movedPath: string | null;
      readonly preserveAcknowledgedRecovery: true;
    }
  | { readonly kind: "markdown-deleted-sidecar-orphaned" }
  | { readonly kind: "markdown-file-relocation"; readonly newPath: string }
  | {
      readonly kind: "folder-path-change";
      readonly markdownAffected: boolean;
      readonly oldPath: string;
      readonly newPath: string;
      readonly sidecarAffected: boolean;
    }
  | { readonly kind: "unrelated" }
  | { readonly kind: "invalid-path" }
  | { readonly kind: "wrong-file-kind" };

function pathIsWithin(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function classifyVaultSidecarEvent(
  identity: OpenSidecarIdentity,
  event: VaultSidecarEvent,
): VaultSidecarEventClassification {
  if (!validEventPaths(identity, event)) return { kind: "invalid-path" };
  if (isVaultFolderCapability(event.target)) {
    return classifyFolderEvent(identity, event);
  }
  if (!isVaultFileCapability(event.target)) return { kind: "wrong-file-kind" };
  return classifyFileEvent(identity, event);
}

function classifyFolderEvent(
  identity: OpenSidecarIdentity,
  event: VaultSidecarEvent,
): VaultSidecarEventClassification {
  if (!isVaultFolderCapability(event.target))
    return { kind: "wrong-file-kind" };
  if (event.kind === "modify") return { kind: "wrong-file-kind" };
  if (event.kind === "create") return { kind: "unrelated" };
  const oldPath = event.kind === "rename" ? event.oldPath : event.target.path;
  if (
    !pathIsWithin(identity.markdownPath, oldPath) &&
    !pathIsWithin(identity.sidecarPath, oldPath)
  ) {
    return { kind: "unrelated" };
  }
  return {
    kind: "folder-path-change",
    markdownAffected: pathIsWithin(identity.markdownPath, oldPath),
    oldPath,
    newPath: event.kind === "rename" ? event.target.path : "",
    sidecarAffected: pathIsWithin(identity.sidecarPath, oldPath),
  };
}

function classifyFileEvent(
  identity: OpenSidecarIdentity,
  event: VaultSidecarEvent,
): VaultSidecarEventClassification {
  if (!isVaultFileCapability(event.target)) return { kind: "wrong-file-kind" };
  if (event.kind === "create" || event.kind === "modify") {
    if (event.target.path !== identity.sidecarPath) {
      return { kind: "unrelated" };
    }
    return { eventKind: event.kind, kind: "sidecar-write" };
  }
  const priorPath = event.kind === "rename" ? event.oldPath : event.target.path;
  if (priorPath === identity.sidecarPath) {
    return {
      kind: "marker-present-sidecar-missing",
      movedPath: event.kind === "rename" ? event.target.path : null,
      preserveAcknowledgedRecovery: true,
    };
  }
  if (priorPath !== identity.markdownPath) return { kind: "unrelated" };
  if (event.kind === "delete") {
    return { kind: "markdown-deleted-sidecar-orphaned" };
  }
  return { kind: "markdown-file-relocation", newPath: event.target.path };
}

function validEventPaths(
  identity: OpenSidecarIdentity,
  event: VaultSidecarEvent,
): boolean {
  if (
    !isValidVaultRelativePathV1(identity.markdownPath, {
      requiredSuffix: ".md",
    }) ||
    !isValidVaultRelativePathV1(identity.sidecarPath, {
      requiredSuffix: SIDECAR_SUFFIX,
    })
  ) {
    return false;
  }
  if (event.kind === "rename" && !isValidVaultRelativePathV1(event.oldPath)) {
    return false;
  }
  if (
    (isVaultFileCapability(event.target) ||
      isVaultFolderCapability(event.target)) &&
    !isValidVaultRelativePathV1(event.target.path)
  ) {
    return false;
  }
  return true;
}

export interface OrphanReviewVaultCapability {
  getFiles(): readonly VaultAbstractFileCapability[];
}

export interface OrphanReviewScheduler {
  now(): number;
  yieldControl(): Promise<void>;
}

export type OrphanReviewResult =
  | { readonly kind: "cancelled" }
  | {
      readonly kind: "complete";
      readonly candidates: readonly VaultFileCapability[];
      readonly continuation: OrphanReviewContinuationV1 | null;
      readonly inspectedFiles: number;
      readonly requiresContinuation: boolean;
    };

export type OrphanReviewContinuationResultV1 =
  OrphanReviewResult | { readonly kind: "stale-continuation" };

export interface OrphanReviewContinuationV1 {
  readonly nextIndex: number;
  readonly priorPath: string;
  readonly reviewId: number;
  readonly totalFiles: number;
}

export class OrphanSidecarReviewer {
  private disposalGeneration = 0;
  private disposed = false;
  private nextReviewId = 0;
  private pendingContinuation: OrphanReviewContinuationV1 | null = null;

  public constructor(
    private readonly vault: OrphanReviewVaultCapability,
    private readonly scheduler: OrphanReviewScheduler,
  ) {}

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposalGeneration += 1;
    this.pendingContinuation = null;
  }

  public async review(signal?: AbortSignal): Promise<OrphanReviewResult> {
    if (this.disposed || isAbortRequested(signal)) return { kind: "cancelled" };
    this.pendingContinuation = null;
    const files = this.vault.getFiles();
    return this.reviewFiles(files, 0, ++this.nextReviewId, signal);
  }

  public async continueReview(
    continuation: OrphanReviewContinuationV1,
    signal?: AbortSignal,
  ): Promise<OrphanReviewContinuationResultV1> {
    if (this.disposed || isAbortRequested(signal)) return { kind: "cancelled" };
    const files = this.vault.getFiles();
    if (!this.isCurrentContinuation(continuation, files)) {
      return { kind: "stale-continuation" };
    }
    return this.reviewFiles(
      files,
      continuation.nextIndex,
      continuation.reviewId,
      signal,
    );
  }

  private async reviewFiles(
    files: readonly VaultAbstractFileCapability[],
    startIndex: number,
    reviewId: number,
    signal?: AbortSignal,
  ): Promise<OrphanReviewResult> {
    if (this.disposed) return { kind: "cancelled" };
    const disposalGeneration = this.disposalGeneration;
    if (isAbortRequested(signal)) return { kind: "cancelled" };
    const candidates: VaultFileCapability[] = [];
    let inspectedFiles = 0;
    let sliceStart = this.scheduler.now();
    for (let index = startIndex; index < files.length; index += 1) {
      const abstractFile = files[index];
      if (
        this.disposalGeneration !== disposalGeneration ||
        isAbortRequested(signal)
      )
        return { kind: "cancelled" };
      inspectedFiles += 1;
      if (
        isVaultFileCapability(abstractFile) &&
        !isHiddenVaultPath(abstractFile.path) &&
        abstractFile.path.endsWith(SIDECAR_SUFFIX)
      ) {
        candidates.push(abstractFile);
        if (candidates.length === ORPHAN_CANDIDATE_LIMIT) {
          return this.complete(
            candidates,
            inspectedFiles,
            files,
            index,
            reviewId,
          );
        }
      }
      const elapsed = this.scheduler.now() - sliceStart;
      if (
        inspectedFiles % REVIEW_INSPECTION_SLICE === 0 ||
        elapsed >= REVIEW_TIME_SLICE_MS
      ) {
        await this.scheduler.yieldControl();
        if (
          this.disposalGeneration !== disposalGeneration ||
          isAbortRequested(signal)
        )
          return { kind: "cancelled" };
        sliceStart = this.scheduler.now();
      }
    }
    this.pendingContinuation = null;
    return this.complete(
      candidates,
      inspectedFiles,
      files,
      files.length,
      reviewId,
    );
  }

  private complete(
    candidates: VaultFileCapability[],
    inspectedFiles: number,
    files: readonly VaultAbstractFileCapability[],
    lastIndex: number,
    reviewId: number,
  ): OrphanReviewResult {
    const nextIndex = lastIndex + 1;
    const continuation =
      nextIndex < files.length
        ? Object.freeze({
            nextIndex,
            priorPath: files[lastIndex]?.path ?? "",
            reviewId,
            totalFiles: files.length,
          })
        : null;
    this.pendingContinuation = continuation;
    return Object.freeze({
      kind: "complete",
      candidates: Object.freeze(candidates.slice()),
      inspectedFiles,
      continuation,
      requiresContinuation: continuation !== null,
    });
  }

  private isCurrentContinuation(
    continuation: OrphanReviewContinuationV1,
    files: readonly VaultAbstractFileCapability[],
  ): boolean {
    const expected = this.pendingContinuation;
    return (
      expected !== null &&
      continuation.reviewId === expected.reviewId &&
      continuation.nextIndex === expected.nextIndex &&
      continuation.priorPath === expected.priorPath &&
      continuation.totalFiles === expected.totalFiles &&
      files.length === expected.totalFiles &&
      files[expected.nextIndex - 1]?.path === expected.priorPath
    );
  }
}
