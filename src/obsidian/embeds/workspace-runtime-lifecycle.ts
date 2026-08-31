import { TFile, type Vault } from "obsidian";

import type { ExternalChangeOutcome } from "../../editor/session/session-port";
import type { ActiveInkbookScene } from "./active-scene";
import { isLiveOwnerWindow } from "./owner-window-registry";
import { presentationAttachmentKey, type PresentationAttachment } from "./presentation-port";
import type { VaultDocumentPersistedEvent } from "./vault-document-recovery";

interface RuntimePresentation {
  readonly attachment: PresentationAttachment;
  readonly scene: ActiveInkbookScene | undefined;
}

interface WorkspaceRuntimeLifecycleOptions {
  readonly activate: (attachment: PresentationAttachment, attempt: number) => void;
  readonly fallbackWindow: () => Window | undefined;
  readonly isDisposed: () => boolean;
  readonly notifyExternalChange: (documentId: string) => Promise<ExternalChangeOutcome | "ignored">;
  readonly presentations: () => Iterable<RuntimePresentation>;
  readonly reloadPresentation: (documentId: string) => void;
  readonly vault: Vault;
}

interface PendingAutoActivation {
  attachmentKey: string | undefined;
  attempt: number;
  readonly documentId: string;
  frame: number | undefined;
  frameWindow: WeakRef<Window> | undefined;
  readonly onTimeout: (retry: () => void) => void;
  readonly ownerWindow: WeakRef<Window>;
  timeout: number | undefined;
}

interface InsertionUndoHint {
  readonly dismiss: () => void;
  strokeCommitted: boolean;
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
  readonly #confirmedHostWrites = new Set<string>();
  readonly #insertionUndoHints = new Map<string, InsertionUndoHint>();
  readonly #options: WorkspaceRuntimeLifecycleOptions;
  #pendingAutoActivation: PendingAutoActivation | undefined;
  readonly #pendingExternalChanges = new Set<string>();

  public constructor(options: WorkspaceRuntimeLifecycleOptions) {
    this.#options = options;
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
    pending.attachmentKey = presentationAttachmentKey(attachment);
    pending.attempt += 1;
    const attempt = pending.attempt;
    pending.frameWindow = new WeakRef(ownerWindow);
    pending.frame = ownerWindow.requestAnimationFrame(() => {
      if (!this.#matchesAttempt(pending, attachment, attempt)) return;
      pending.frame = ownerWindow.requestAnimationFrame(() =>
        this.#activatePending(pending, attachment, attempt),
      );
    });
  }

  public completeAutoActivation(attachment: PresentationAttachment, attempt?: number): void {
    const pending = this.#pendingAutoActivation;
    if (!this.#matchesAttempt(pending, attachment, attempt)) return;
    this.#cancelAutoActivation();
  }

  public failAutoActivation(attachment: PresentationAttachment, attempt?: number): void {
    const pending = this.#pendingAutoActivation;
    if (!this.#matchesAttempt(pending, attachment, attempt)) return;
    this.#clearPendingFrame(pending);
    pending.attachmentKey = undefined;
  }

  public detachAutoActivation(attachment: PresentationAttachment): void {
    const pending = this.#pendingAutoActivation;
    if (pending?.attachmentKey !== presentationAttachmentKey(attachment)) return;
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

  public handleVaultModification(documentId: string): void {
    if (this.#options.isDisposed() || this.#pendingExternalChanges.has(documentId)) return;
    this.#pendingExternalChanges.add(documentId);
    const run = (): void => this.#processVaultModification(documentId);
    const ownerWindow = this.#options.fallbackWindow();
    if (ownerWindow === undefined) run();
    else ownerWindow.setTimeout(run, 0);
  }

  public handlePersisted(event: VaultDocumentPersistedEvent): void {
    if (this.#options.isDisposed()) return;
    if (this.#pendingExternalChanges.has(event.documentId)) {
      this.#confirmedHostWrites.add(event.documentId);
    }
    const hint = this.#insertionUndoHints.get(event.documentId);
    if (hint?.strokeCommitted === true) {
      this.#insertionUndoHints.delete(event.documentId);
      hint.dismiss();
    }
    this.#refreshPreviews(event.documentId, `${String(event.revision)}-${event.outputHash}`);
  }

  public updateSavedCopyPreview(presentation: RuntimePresentation, savedPath: string): void {
    const file = this.#options.vault.getFileByPath(savedPath);
    if (!(file instanceof TFile)) return;
    const source = this.#options.vault.getResourcePath(file);
    presentation.scene?.setPreviewSource(source);
    updatePreviewImages(presentation.attachment.root, source);
  }

  public dispose(): void {
    this.#cancelAutoActivation();
    this.#insertionUndoHints.clear();
    this.#confirmedHostWrites.clear();
    this.#pendingExternalChanges.clear();
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

  #processVaultModification(documentId: string): void {
    this.#pendingExternalChanges.delete(documentId);
    if (this.#options.isDisposed() || this.#confirmedHostWrites.delete(documentId)) return;
    void this.#options.notifyExternalChange(documentId).then((outcome) => {
      if (outcome === "reloaded" && !this.#options.isDisposed()) {
        this.#options.reloadPresentation(documentId);
      }
    });
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

  #cancelAutoActivation(): void {
    const pending = this.#pendingAutoActivation;
    if (pending === undefined) return;
    this.#clearPendingHandles(pending);
    this.#pendingAutoActivation = undefined;
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
    const frameWindow = pending.frameWindow?.deref();
    if (pending.frame !== undefined && isLiveOwnerWindow(frameWindow)) {
      frameWindow.cancelAnimationFrame(pending.frame);
    }
    pending.frame = undefined;
    pending.frameWindow = undefined;
  }
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
    frameWindow: undefined,
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
