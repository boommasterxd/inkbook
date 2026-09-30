import { TFile, type Vault } from "obsidian";

import { FILE_SCHEMA_LIMITS } from "../../domain/schema/public";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import type { ExternalChangeOutcome } from "../../editor/session/session-port";
import { hashConfirmedSvgContent } from "../../persistence/scheduling/trusted-svg-output";
import { VerifiedMetadataGuardedFileRead } from "../../persistence/saving/verified-file-read";
import { scanCanonicalRevisionPrefix } from "../../persistence/saving/revision-scan";
import type { ActiveInkbookScene } from "./active-scene";
import { isLiveOwnerWindow, resolvePresentationWindow } from "./owner-window-registry";
import { presentationAttachmentKey, type PresentationAttachment } from "./presentation-port";
import type { VaultDocumentPersistedEvent } from "./vault-document-recovery";

interface RuntimePresentation {
  readonly attachment: PresentationAttachment;
  readonly scene: ActiveInkbookScene | undefined;
}

interface WorkspaceRuntimeLifecycleOptions {
  readonly activate: (attachment: PresentationAttachment, attempt: number) => void;
  readonly autoActivationCancelled?: (attachmentKey: string) => void;
  readonly fallbackWindow: () => Window | undefined;
  readonly isDisposed: () => boolean;
  readonly notifyExternalChange: (documentId: string) => Promise<ExternalChangeOutcome | "ignored">;
  readonly presentations: () => Iterable<RuntimePresentation>;
  readonly reloadPresentation: (documentId: string) => void;
  readonly vault: Vault;
  readonly workScheduler: (ownerWindow: Window | null) => WorkScheduler;
}

interface PendingAutoActivation {
  attachmentKey: string | undefined;
  attempt: number;
  readonly documentId: string;
  frame: number | undefined;
  frameScheduler: WorkScheduler | undefined;
  readonly onTimeout: (retry: () => void) => void;
  readonly ownerWindow: WeakRef<Window>;
  timeout: number | undefined;
}

interface InsertionUndoHint {
  readonly dismiss: () => void;
  strokeCommitted: boolean;
}

export type HostWriteResolved = (output?: {
  readonly content: string;
  readonly outputHash: string;
  readonly signature: string;
}) => void;
export type ConfirmedOutputReceiver = (
  documentId: string,
  output: Parameters<HostWriteResolved>[0],
) => void;

interface PendingVaultModification {
  readonly resolved?: HostWriteResolved;
  frame: { readonly handle: number; readonly scheduler: WorkScheduler } | undefined;
  generation: number;
}

interface PersistedIdentity {
  readonly outputHash: string;
  readonly revision: number;
}

export interface WindowTimeoutHandle {
  readonly handle: number;
  readonly ownerWindow: WeakRef<Window>;
}

export function clearWindowTimeout(timeout: WindowTimeoutHandle): void {
  const ownerWindow = timeout.ownerWindow.deref();
  if (isLiveOwnerWindow(ownerWindow)) ownerWindow.clearTimeout(timeout.handle);
}

export function isWindowTimeoutHandle(value: unknown): value is WindowTimeoutHandle {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "handle") === "number" &&
    Reflect.get(value, "ownerWindow") instanceof WeakRef
  );
}

export class WorkspaceRuntimeLifecycle {
  #confirmedOutputReceiver: ConfirmedOutputReceiver | undefined;
  readonly #confirmedHostWrites = new Map<string, Set<string>>();
  readonly #insertionUndoHints = new Map<string, InsertionUndoHint>();
  readonly #options: WorkspaceRuntimeLifecycleOptions;
  #pendingAutoActivation: PendingAutoActivation | undefined;
  readonly #pendingExternalChanges = new Map<string, PendingVaultModification>();

  public constructor(options: WorkspaceRuntimeLifecycleOptions) {
    this.#options = options;
  }

  public setConfirmedOutputReceiver(receiver: ConfirmedOutputReceiver): void {
    this.#confirmedOutputReceiver = receiver;
  }

  public queueAutoActivation(
    documentId: string,
    ownerWindow: Window,
    onTimeout: (retry: () => void) => void,
    dismissUndoHint?: () => void,
  ): void {
    if (this.#options.isDisposed()) return;
    if (dismissUndoHint !== undefined) {
      this.#insertionUndoHints.set(documentId, {
        dismiss: dismissUndoHint,
        strokeCommitted: false,
      });
    }
    this.#cancelAutoActivation();
    const pending = createPendingAutoActivation(documentId, ownerWindow, onTimeout);
    this.#pendingAutoActivation = pending;
    this.#armAutoActivationTimeout(pending);
    for (const mounted of this.#options.presentations()) {
      if (mounted.attachment.documentId !== documentId) continue;
      this.continueAutoActivation(mounted.attachment);
      break;
    }
  }

  public continueAutoActivation(attachment: PresentationAttachment): void {
    const pending = this.#pendingAutoActivation;
    if (
      this.#options.isDisposed() ||
      pending === undefined ||
      pending.documentId !== attachment.documentId ||
      pending.attachmentKey !== undefined
    ) {
      return;
    }
    const ownerWindow = attachment.root.ownerDocument.defaultView;
    if (ownerWindow === null) return;
    attachment.initialEntrance?.holdForActivation();
    pending.attachmentKey = presentationAttachmentKey(attachment);
    pending.attempt += 1;
    const attempt = pending.attempt;
    const scheduler = this.#options.workScheduler(ownerWindow);
    pending.frameScheduler = scheduler;
    pending.frame = scheduler.requestFrame(() => {
      if (!this.#matchesAttempt(pending, attachment, attempt)) return;
      pending.frame = scheduler.requestFrame(() =>
        this.#activatePending(pending, attachment, attempt),
      );
    });
  }

  public hasPendingAutoActivation(attachment: PresentationAttachment): boolean {
    return this.#pendingAutoActivation?.attachmentKey === presentationAttachmentKey(attachment);
  }

  public completeAutoActivation(attachment: PresentationAttachment, attempt?: number): void {
    const pending = this.#pendingAutoActivation;
    if (!this.#matchesAttempt(pending, attachment, attempt)) return;
    this.#cancelAutoActivation(false);
  }

  public failAutoActivation(attachment: PresentationAttachment, attempt?: number): void {
    const pending = this.#pendingAutoActivation;
    if (!this.#matchesAttempt(pending, attachment, attempt)) return;
    attachment.initialEntrance?.resumePreview();
    this.#clearPendingFrame(pending);
    pending.attachmentKey = undefined;
  }

  public detachAutoActivation(attachment: PresentationAttachment): void {
    const pending = this.#pendingAutoActivation;
    if (pending?.attachmentKey !== presentationAttachmentKey(attachment)) return;
    attachment.initialEntrance?.resumePreview();
    this.#clearPendingFrame(pending);
    pending.attachmentKey = undefined;
    for (const mounted of this.#options.presentations()) {
      if (mounted.attachment.documentId !== pending.documentId) continue;
      this.continueAutoActivation(mounted.attachment);
      break;
    }
  }

  public abortAutoActivation(documentId: string): void {
    if (this.#pendingAutoActivation?.documentId === documentId) this.#cancelAutoActivation();
  }

  public markFirstStroke(documentId: string): void {
    const hint = this.#insertionUndoHints.get(documentId);
    if (hint !== undefined) hint.strokeCommitted = true;
  }

  public handleVaultModification(documentId: string, resolved?: HostWriteResolved): void {
    if (this.#options.isDisposed()) return;
    const pending = this.#pendingExternalChanges.get(documentId);
    if (pending !== undefined) {
      pending.generation += 1;
      return;
    }
    const created = {
      frame: undefined,
      generation: 1,
      ...(resolved === undefined ? {} : { resolved }),
    };
    this.#pendingExternalChanges.set(documentId, created);
    this.#scheduleVaultModification(documentId, created);
  }

  public handlePersisted(event: VaultDocumentPersistedEvent): void {
    if (this.#options.isDisposed()) return;
    const adopted = this.#adoptConfirmedReadBack(event);
    if (!adopted && this.#pendingExternalChanges.has(event.documentId)) {
      const confirmations = this.#confirmedHostWrites.get(event.documentId) ?? new Set<string>();
      confirmations.add(persistedIdentityKey(event));
      this.#confirmedHostWrites.set(event.documentId, confirmations);
    }
    const hint = this.#insertionUndoHints.get(event.documentId);
    if (hint?.strokeCommitted === true) {
      this.#insertionUndoHints.delete(event.documentId);
      hint.dismiss();
    }
    this.#refreshPreviews(event.documentId, `${String(event.revision)}-${event.outputHash}`);
  }

  #adoptConfirmedReadBack(event: VaultDocumentPersistedEvent): boolean {
    const read = event.readBack;
    if (
      read === undefined ||
      !VerifiedMetadataGuardedFileRead.isVerified(read) ||
      read.identity.path !== event.documentId ||
      read.isCurrent?.() !== true
    )
      return false;
    const pending = this.#pendingExternalChanges.get(event.documentId);
    const output = {
      content: read.content,
      outputHash: event.outputHash,
      signature: `${String(read.identity.ctime)}:${String(read.identity.mtime)}:${String(read.identity.size)}`,
    };
    if (pending?.frame !== undefined) pending.frame.scheduler.cancelFrame(pending.frame.handle);
    this.#pendingExternalChanges.delete(event.documentId);
    this.#confirmedHostWrites.delete(event.documentId);
    if (pending?.resolved !== undefined) pending.resolved(output);
    else this.#confirmedOutputReceiver?.(event.documentId, output);
    return true;
  }

  public updateSavedCopyPreview(presentation: RuntimePresentation, savedPath: string): void {
    const file = this.#options.vault.getFileByPath(savedPath);
    if (!(file instanceof TFile)) return;
    const source = this.#options.vault.getResourcePath(file);
    presentation.scene?.setPreviewSource(source);
    updatePreviewImages(presentation.attachment.root, source);
  }

  public refreshPersistedPreview(documentId: string, identity: PersistedIdentity): void {
    this.#refreshPreviews(documentId, persistedIdentityKey(identity));
  }

  public dispose(): void {
    this.#cancelAutoActivation();
    for (const pending of this.#pendingExternalChanges.values()) {
      if (pending.frame !== undefined) pending.frame.scheduler.cancelFrame(pending.frame.handle);
    }
    this.#insertionUndoHints.clear();
    this.#confirmedHostWrites.clear();
    this.#pendingExternalChanges.clear();
    this.#confirmedOutputReceiver = undefined;
  }

  #activatePending(
    pending: PendingAutoActivation,
    attachment: PresentationAttachment,
    attempt: number,
  ): void {
    if (!this.#matchesAttempt(pending, attachment, attempt)) return;
    this.#clearPendingFrame(pending);
    this.#options.activate(attachment, attempt);
  }

  #armAutoActivationTimeout(pending: PendingAutoActivation): void {
    const ownerWindow = pending.ownerWindow.deref();
    if (!isLiveOwnerWindow(ownerWindow)) return;
    pending.timeout = ownerWindow.setTimeout(() => {
      if (this.#pendingAutoActivation !== pending) return;
      pending.timeout = undefined;
      for (const mounted of this.#options.presentations()) {
        if (presentationAttachmentKey(mounted.attachment) === pending.attachmentKey)
          mounted.attachment.initialEntrance?.resumePreview();
      }
      pending.onTimeout(() => this.#retryAutoActivation(pending));
    }, 2000);
  }

  #retryAutoActivation(pending: PendingAutoActivation): void {
    if (this.#pendingAutoActivation !== pending || pending.timeout !== undefined) return;
    this.#clearPendingFrame(pending);
    pending.attachmentKey = undefined;
    this.#armAutoActivationTimeout(pending);
    for (const mounted of this.#options.presentations()) {
      if (mounted.attachment.documentId !== pending.documentId) continue;
      this.continueAutoActivation(mounted.attachment);
      break;
    }
  }

  #matchesAttempt(
    pending: PendingAutoActivation | undefined,
    attachment: PresentationAttachment,
    attempt: number | undefined,
  ): pending is PendingAutoActivation {
    return (
      pending !== undefined &&
      pending.attempt === attempt &&
      pending.attachmentKey === presentationAttachmentKey(attachment)
    );
  }

  async #processVaultModification(
    documentId: string,
    pending: PendingVaultModification,
  ): Promise<void> {
    const generation = pending.generation;
    const persisted = await this.#readPersistedIdentity(documentId);
    if (this.#options.isDisposed() || this.#pendingExternalChanges.get(documentId) !== pending) {
      return;
    }
    if (pending.generation !== generation) {
      this.#scheduleVaultModification(documentId, pending);
      return;
    }
    this.#pendingExternalChanges.delete(documentId);
    const confirmations = this.#confirmedHostWrites.get(documentId);
    this.#confirmedHostWrites.delete(documentId);
    if (persisted !== undefined && confirmations?.has(persistedIdentityKey(persisted)) === true) {
      pending.resolved?.(persisted);
      return;
    }
    pending.resolved?.();
    void this.#options.notifyExternalChange(documentId).then((outcome) => {
      if (outcome === "reloaded" && !this.#options.isDisposed()) {
        this.#options.reloadPresentation(documentId);
      }
    });
  }

  async #readPersistedIdentity(
    documentId: string,
  ): Promise<
    (PersistedIdentity & { readonly content: string; readonly signature: string }) | undefined
  > {
    const file = this.#options.vault.getFileByPath(documentId);
    if (!(file instanceof TFile)) return undefined;
    if (file.stat.size < 0 || file.stat.size > FILE_SCHEMA_LIMITS.totalInputBytes) return undefined;
    const before = fileSignature(file);
    try {
      const content = await this.#options.vault.read(file);
      if (!sameVaultFile(this.#options.vault, documentId, file, before)) return undefined;
      const revision = scanCanonicalRevisionPrefix(content);
      if (revision === null) return undefined;
      const outputHash = await hashConfirmedSvgContent(content, {
        workScheduler: this.#options.workScheduler(
          resolvePresentationWindow(documentId, this.#options.presentations()) ??
            this.#options.fallbackWindow() ??
            null,
        ),
      });
      return sameVaultFile(this.#options.vault, documentId, file, before)
        ? { content, outputHash, revision, signature: before }
        : undefined;
    } catch {
      return undefined;
    }
  }

  #scheduleVaultModification(documentId: string, pending: PendingVaultModification): void {
    const scheduler = this.#options.workScheduler(this.#options.fallbackWindow() ?? null);
    const handle = scheduler.requestFrame(() => {
      pending.frame = undefined;
      if (!this.#options.isDisposed() && this.#pendingExternalChanges.get(documentId) === pending)
        void this.#processVaultModification(documentId, pending);
    });
    pending.frame = { handle, scheduler };
  }

  #refreshPreviews(documentId: string, cacheKey: string): void {
    const file = this.#options.vault.getFileByPath(documentId);
    if (!(file instanceof TFile)) return;
    const source = withRevision(this.#options.vault.getResourcePath(file), cacheKey);
    for (const mounted of this.#options.presentations()) {
      if (mounted.attachment.documentId !== documentId) continue;
      if (mounted.scene === undefined) {
        void mounted.attachment.setPreviewSource?.(source).catch(() => undefined);
      } else mounted.scene.setPreviewSource(source);
      updatePreviewImages(mounted.attachment.root, source);
    }
  }

  #cancelAutoActivation(resumePreview = true): void {
    const pending = this.#pendingAutoActivation;
    if (pending === undefined) return;
    this.#clearPendingHandles(pending);
    this.#pendingAutoActivation = undefined;
    if (pending.attachmentKey !== undefined && resumePreview)
      this.#options.autoActivationCancelled?.(pending.attachmentKey);
  }

  #clearPendingHandles(pending: PendingAutoActivation): void {
    this.#clearPendingFrame(pending);
    const timeoutWindow = pending.ownerWindow.deref();
    if (pending.timeout !== undefined && isLiveOwnerWindow(timeoutWindow)) {
      timeoutWindow.clearTimeout(pending.timeout);
    }
    pending.timeout = undefined;
  }

  #clearPendingFrame(pending: PendingAutoActivation): void {
    if (pending.frame !== undefined) pending.frameScheduler?.cancelFrame(pending.frame);
    pending.frame = undefined;
    pending.frameScheduler = undefined;
  }
}

function fileSignature(file: TFile): string {
  return `${String(file.stat.ctime)}:${String(file.stat.mtime)}:${String(file.stat.size)}`;
}

function sameVaultFile(vault: Vault, documentId: string, file: TFile, signature: string): boolean {
  const current = vault.getFileByPath(documentId);
  return current === file && fileSignature(file) === signature;
}

function persistedIdentityKey(identity: PersistedIdentity): string {
  return `${String(identity.revision)}:${identity.outputHash}`;
}

function createPendingAutoActivation(
  documentId: string,
  ownerWindow: Window,
  onTimeout: (retry: () => void) => void,
): PendingAutoActivation {
  return {
    attachmentKey: undefined,
    attempt: 0,
    documentId,
    frame: undefined,
    frameScheduler: undefined,
    onTimeout,
    ownerWindow: new WeakRef(ownerWindow),
    timeout: undefined,
  };
}

function updatePreviewImages(root: HTMLElement, source: string): void {
  const images = root.getElementsByTagName("img");
  for (let index = 0; index < images.length; index += 1) {
    const image = images.item(index);
    if (image !== null) image.src = source;
  }
}

function withRevision(source: string, revision: string): string {
  try {
    const url = new URL(source);
    url.searchParams.set("inkbook-revision", revision);
    return url.href;
  } catch {
    const separator = source.includes("?") ? "&" : "?";
    return `${source}${separator}inkbook-revision=${encodeURIComponent(revision)}`;
  }
}
