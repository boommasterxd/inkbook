import type { EditorChromeOpenings } from "./editor-chrome-openings";
import type { FileManager, Vault } from "obsidian";
import type { WorkspaceRuntimeSettings } from "./workspace-active-scene";
import type { InkbookDeviceSettingsV2, InkbookSettingsV4 } from "../../domain/settings/types";
import type { PresentationLifecyclePort } from "../../editor/session/session-port";
import { WorkspaceEditorCoordinator } from "../../editor/session/workspace-editor-coordinator";
import type { AttachmentIdentity } from "../../editor/session/session-state";
import type { ColorSchemeBroadcaster } from "../theme/color-scheme";
import type { InkbookCommandAction, ObsidianEmbedActions } from "../commands";
import {
  OwnerWindowRegistry,
  pruneOwnerWindowRegistry,
  resolveFallbackWindow,
} from "./owner-window-registry";
import {
  presentationAttachmentKey,
  type PresentationAttachment,
  type PresentationSessionPort,
} from "./presentation-port";
import {
  type ConfirmedOutputReceiver,
  type HostWriteResolved,
  WorkspaceRuntimeLifecycle,
} from "./workspace-runtime-lifecycle";
import {
  handleWorkspaceActivationFailure,
  showWorkspaceLoadRecovery,
  type WorkspaceLoadFeedbackCode,
  type WorkspaceMountedPresentation,
} from "./workspace-load-recovery";
import {
  beginWorkspaceActivation,
  isCurrentPresentationActivation,
  mountWorkspaceActiveScene,
  presentationActivationReady,
} from "./workspace-runtime-scene-readiness";
import {
  activeWorkspaceScene,
  executeWorkspaceSceneAction,
  recordWorkspaceMarkdownHistory,
} from "./workspace-runtime-editor";
import { WorkspaceDocumentStatus } from "./workspace-document-status";
import { createWorkspaceSessionFactory } from "./workspace-runtime-workers";
import { showWorkspaceHeadlessRecovery } from "./workspace-recovery-actions";
import type { VaultDocumentSessionFactory } from "./vault-document-session-factory";
import { showAttachedRecoveryPanel, type HeadlessRecoveryNotice } from "./recovery-notice";
import {
  createWorkspaceMountedPresentation,
  createWorkspacePresentationStateSetter,
  disposeWorkspaceMountedPresentations,
  cancelInitialWorkspaceLoading,
  startInitialWorkspaceLoading,
  updateWorkspaceMountedSettings,
} from "./workspace-mounted-presentation";
import { WorkspaceRefreshProfiles } from "./workspace-refresh-profiles";
import { WorkspaceFeedbackRouter, type WorkspaceFeedbackHost } from "./workspace-feedback-router";
import * as trustedHeadStorage from "../storage/trusted-document-head-ledger";
import type { SafeStaticProof } from "../../persistence/serialization/safe-static-proof";
export class ObsidianWorkspaceRuntime implements PresentationSessionPort {
  readonly #host: WorkspaceFeedbackHost & Omit<EditorChromeOpenings, "confirmEraseAll">;
  readonly #coordinator: WorkspaceEditorCoordinator;
  #disposed = false;
  readonly #embedActions: ObsidianEmbedActions;
  readonly #fallbackOwnerWindow: () => Window | undefined;
  readonly #feedback: WorkspaceFeedbackRouter;
  #headlessRecovery: HeadlessRecoveryNotice | undefined;
  readonly #lifecycle: WorkspaceRuntimeLifecycle;
  readonly #ownerWindows: OwnerWindowRegistry;
  readonly #mounted = new Map<string, WorkspaceMountedPresentation>();
  readonly #setState = createWorkspacePresentationStateSetter(this.#mounted);
  readonly refreshRateProfiles: WorkspaceRefreshProfiles;
  readonly #scheme: ColorSchemeBroadcaster;
  readonly #sessions: VaultDocumentSessionFactory;
  #safeStaticProof: ((documentId: string) => SafeStaticProof | undefined) | undefined;
  readonly #settings: () => WorkspaceRuntimeSettings;
  readonly documentStatus: WorkspaceDocumentStatus;
  constructor(
    vault: Vault,
    fileManager: FileManager,
    scheme: ColorSchemeBroadcaster,
    settings: () => WorkspaceRuntimeSettings,
    embedActions: ObsidianEmbedActions,
    host: WorkspaceFeedbackHost &
      Omit<EditorChromeOpenings, "confirmEraseAll"> & {
        readonly deviceStorage?: trustedHeadStorage.DeviceLocalStoragePort;
        readonly resolveDocumentStatusPane?: (root: HTMLElement) => HTMLElement | undefined;
      },
  ) {
    const trustedHeads =
      host.deviceStorage === undefined
        ? undefined
        : new trustedHeadStorage.TrustedDocumentHeadLedger(host.deviceStorage);
    this.#host = host;
    this.documentStatus = new WorkspaceDocumentStatus(host.resolveDocumentStatusPane);
    this.#embedActions = embedActions;
    this.#fallbackOwnerWindow = host.fallbackOwnerWindow;
    this.#feedback = new WorkspaceFeedbackRouter(host.manager, (documentId) =>
      this.#owningWindow(documentId),
    );
    this.#scheme = scheme;
    this.#settings = settings;
    this.refreshRateProfiles = new WorkspaceRefreshProfiles(settings().vault.refreshRatePreference);
    this.#ownerWindows = new OwnerWindowRegistry((ownerWindow) =>
      this.refreshRateProfiles.isWindowAvailable(ownerWindow),
    );
    this.refreshRateProfiles.observeDefault(this.#fallbackOwnerWindow());
    this.#lifecycle = new WorkspaceRuntimeLifecycle({
      activate: (attachment, attempt) => this.#activate(attachment, attempt),
      autoActivationCancelled: (key) => cancelInitialWorkspaceLoading(this.#mounted.get(key)),
      fallbackWindow: () => this.#fallbackWindow(),
      isDisposed: () => this.#disposed,
      currentSaveSettlement: (documentId) => this.#sessions.currentSaveSettlement(documentId),
      notifyExternalChange: (documentId) => this.#coordinator.notifyExternalChange(documentId),
      presentations: () => this.#mounted.values(),
      reloadPresentation: (documentId) => this.#reloadPresentation(documentId),
      workScheduler: (ownerWindow) => this.refreshRateProfiles.workScheduler(ownerWindow),
      vault,
    });
    this.#sessions = createWorkspaceSessionFactory({
      vault,
      fileManager,
      profiles: this.refreshRateProfiles,
      fallbackWindow: this.#fallbackWindow,
      owningWindow: (documentId) => this.#owningWindow(documentId),
      hooks: {
        persisted: (event) => this.#lifecycle.handlePersisted(event),
        safeStaticProof: (documentId) => this.#safeStaticProof?.(documentId),
        ...(trustedHeads === undefined ? {} : { trustedHeads }),
      },
    });
    const presentations: PresentationLifecyclePort = {
      cancelGesture: (attachment) =>
        this.#mounted.get(presentationAttachmentKey(attachment))?.scene?.disableInput(),
      disableInput: (attachment) => {
        const mounted = this.#mounted.get(presentationAttachmentKey(attachment));
        mounted?.scene?.disableInput();
        if (mounted !== undefined) {
          mounted.savingFeedback = mounted.feedback.begin("saving");
        }
        this.#setState(attachment, "locking");
      },
      release: (attachment) => this.#releaseScene(attachment),
    };
    this.#coordinator = new WorkspaceEditorCoordinator({
      notifications: {
        attachedRecoveryRequired: (notice) => this.#showAttachedRecovery(notice),
        headlessRecoveryRequired: (notice) => this.#showHeadlessRecovery(notice.documentId),
      },
      presentations,
      sessions: this.#sessions,
    });
  }
  mount(attachment: PresentationAttachment): void {
    if (this.#disposed) return;
    const key = presentationAttachmentKey(attachment);
    if (this.#mounted.has(key)) {
      this.#ownerWindows.observe(attachment.documentId, attachment.root.ownerDocument.defaultView);
      this.refreshRateProfiles.acquire(
        key,
        attachment.root.ownerDocument.defaultView,
        attachment.root.ownerDocument,
      );
      return;
    }
    const mounted = createWorkspaceMountedPresentation(
      attachment,
      this.refreshRateProfiles.workScheduler(attachment.root.ownerDocument.defaultView),
    );
    this.#mounted.set(key, mounted);
    startInitialWorkspaceLoading(mounted, this.#lifecycle);
    this.#ownerWindows.observe(attachment.documentId, attachment.root.ownerDocument.defaultView);
    this.refreshRateProfiles.acquire(
      key,
      attachment.root.ownerDocument.defaultView,
      attachment.root.ownerDocument,
    );
    attachment.root.dataset.inkbookState = "locked";
    this.#coordinator.mountAttachment(attachment);
    this.#lifecycle.continueAutoActivation(attachment);
  }
  readonly activate = (attachment: PresentationAttachment): void => this.#activate(attachment);
  #activate(attachment: PresentationAttachment, autoActivationAttempt?: number): void {
    if (this.#disposed) return;
    const mounted = this.#mounted.get(presentationAttachmentKey(attachment));
    if (mounted === undefined) return;
    const activation = beginWorkspaceActivation(mounted, autoActivationAttempt);
    if (activation === undefined) return;
    this.documentStatus.detach(attachment);
    const loadFeedback = activation.feedback;
    this.#setState(attachment, "unlocking");
    const handle = this.#coordinator.requestActivation(attachment);
    void handle.outcome
      .then(async (outcome) => {
        if (outcome.kind !== "activated") {
          handleWorkspaceActivationFailure(outcome, {
            failAutoActivation: () =>
              this.#lifecycle.failAutoActivation(attachment, activation.autoActivationAttempt),
            refreshPreview: (identity) =>
              this.#lifecycle.refreshPersistedPreview(attachment.documentId, identity),
            setState: (state) => this.#setState(attachment, state, loadFeedback),
            showLoadError: (code) => this.#showLoadError(mounted, code),
          });
          return;
        }
        if (outcome.phase !== "active") {
          this.#lifecycle.failAutoActivation(attachment, activation.autoActivationAttempt);
          this.#setState(attachment, outcome.phase, loadFeedback);
          return;
        }
        const presented = await presentationActivationReady(attachment);
        const context = this.#sessions.getEditorContext(outcome.sessionId);
        const current = this.#mounted.get(presentationAttachmentKey(attachment))?.activation;
        const isActive = () =>
          isCurrentPresentationActivation(
            this.#coordinator.getSnapshot(),
            attachment,
            outcome.sessionId,
          );
        if (!presented || context === undefined || current !== activation || !isActive()) {
          loadFeedback?.finish();
          this.#lifecycle.failAutoActivation(attachment, activation.autoActivationAttempt);
          return;
        }
        const settings = this.#settings();
        await mountWorkspaceActiveScene({
          confirmEraseAll: this.#host.confirmEraseAll,
          attachment,
          backgroundSpacing: () => this.#settings().vault.pageDefaults.backgroundSpacing,
          deviceSettings: settings.device,
          editorContext: context,
          embedActions: this.#embedActions,
          isCurrent: (scene) =>
            this.#mounted.get(presentationAttachmentKey(attachment)) === mounted &&
            mounted.scene === scene,
          keymap: this.#host.keymap,
          ...(this.#host.createPhoneSheetHost === undefined
            ? {}
            : { createPhoneSheetHost: this.#host.createPhoneSheetHost }),
          markFirstStroke: () => this.#lifecycle.markFirstStroke(attachment.documentId),
          onLock: () => this.lockActivePresentation(),
          onOpenSettings: this.#host.onOpenSettings,
          onOpenShortcuts: this.#host.onOpenShortcuts,
          scheme: attachment.root.dataset.inkbookScheme === "dark" ? "dark" : "light",
          showFeedback: (code) => this.#feedback.showInPresentation(attachment.root, code),
          workScheduler: this.refreshRateProfiles.workScheduler(
            attachment.root.ownerDocument.defaultView,
          ),
          vaultSettings: settings.vault,
          colorScheme: this.#scheme,
          mounted,
          onFailure: () => {
            this.#setState(attachment, "load-error", loadFeedback);
            this.#showLoadError(mounted, "editor-start-failed");
            this.#lifecycle.failAutoActivation(attachment, activation.autoActivationAttempt);
          },
          onReady: () => {
            if (!isActive()) return;
            this.documentStatus.bind(attachment, context.model);
            this.#setState(attachment, "active", loadFeedback);
            this.#lifecycle.completeAutoActivation(attachment, activation.autoActivationAttempt);
          },
        });
      })
      .catch(() => {
        this.#setState(attachment, "load-error", loadFeedback);
        this.#showLoadError(mounted);
        this.#lifecycle.failAutoActivation(attachment, activation.autoActivationAttempt);
      })
      .finally(activation.release);
  }
  detach(attachment: PresentationAttachment): void {
    this.#coordinator.detachAttachment(attachment);
    this.#releaseScene(attachment);
    this.#mounted.delete(presentationAttachmentKey(attachment));
    this.refreshRateProfiles.release(presentationAttachmentKey(attachment));
    this.#lifecycle.detachAutoActivation(attachment);
    pruneOwnerWindowRegistry(
      this.#ownerWindows,
      this.#mounted.values(),
      this.#coordinator.getSnapshot().current?.documentId,
    );
    this.refreshRateProfiles.notifyOwnerWindowChanged();
  }
  hasActivePresentation(): boolean {
    return this.#coordinator.getSnapshot().current?.phase === "active";
  }
  execute(action: InkbookCommandAction): void {
    if (action === "lock") {
      if (!this.lockActivePresentation()) throw new Error("No active Inkbook presentation.");
      return;
    }
    executeWorkspaceSceneAction(action, this.#coordinator.getSnapshot(), this.#mounted);
  }
  isAvailable(action: InkbookCommandAction): boolean {
    if (action === "lock") return this.hasActivePresentation();
    const scene = activeWorkspaceScene(this.#coordinator.getSnapshot(), this.#mounted);
    return scene?.isActionAvailable(action) ?? false;
  }
  readonly lockActivePresentation = (): boolean => this.#coordinator.requestLockCurrent();
  readonly getMotionPreference = () => this.#settings().device.motion;
  updateDeviceSettings(settings: InkbookDeviceSettingsV2): void {
    if (this.#disposed) return;
    updateWorkspaceMountedSettings(this.#mounted.values(), settings);
  }
  updateVaultSettings(settings: InkbookSettingsV4): void {
    if (this.#disposed) return;
    this.refreshRateProfiles.setPreference(settings.refreshRatePreference);
    for (const mounted of this.#mounted.values()) {
      mounted.scene?.updateSnappingSettings(settings.snapping);
      mounted.scene?.updateSelectionHighlights(settings.selectionHighlightsEnabled);
    }
  }
  queueAutoActivation(
    documentId: string,
    ownerWindow: Window,
    onTimeout: (retry: () => void) => void,
    dismissUndoHint?: () => void,
  ): () => void {
    return this.#lifecycle.queueAutoActivation(documentId, ownerWindow, onTimeout, dismissUndoHint);
  }
  readonly abortAutoActivation = (documentId: string): void =>
    this.#lifecycle.abortAutoActivation(documentId);
  readonly handleVaultModification = (documentId: string, resolved?: HostWriteResolved): void => {
    this.#sessions.noteVaultModification(documentId);
    this.#lifecycle.handleVaultModification(documentId, resolved);
  };
  readonly setConfirmedOutputReceiver = (receiver: ConfirmedOutputReceiver): void =>
    this.#lifecycle.setConfirmedOutputReceiver(receiver);
  readonly setSafeStaticProofProvider = (
    provider: (documentId: string) => SafeStaticProof | undefined,
  ): void => {
    this.#safeStaticProof = provider;
  };
  handleMarkdownEditorChange(sourcePath: string, pane: HTMLElement): void {
    if (this.#disposed) return;
    recordWorkspaceMarkdownHistory(
      this.#coordinator.getSnapshot(),
      this.#mounted,
      sourcePath,
      pane,
    );
  }
  readonly prepareForQuit = (): Promise<void> => this.#sessions.prepareForUnload();
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.documentStatus.dispose();
    this.#safeStaticProof = undefined;
    this.#lifecycle.dispose();
    this.#headlessRecovery?.close();
    this.#headlessRecovery = undefined;
    const persistenceDrained = this.#sessions.prepareForUnload();
    this.#coordinator.dispose({ preparePersistence: true });
    disposeWorkspaceMountedPresentations(this.#mounted.values());
    this.#mounted.clear();
    const releaseScheduling = () => {
      this.refreshRateProfiles.dispose();
      this.#ownerWindows.clear();
    };
    void persistenceDrained.then(releaseScheduling, releaseScheduling);
  }
  #reloadPresentation(documentId: string): void {
    const current = this.#coordinator.getSnapshot().current;
    if (current?.documentId !== documentId || current.attachment === undefined) return;
    const mounted = this.#mounted.get(presentationAttachmentKey(current.attachment));
    if (mounted !== undefined) this.activate(mounted.attachment);
  }
  #releaseScene(attachment: AttachmentIdentity): void {
    this.documentStatus.detach(attachment);
    const mounted = this.#mounted.get(presentationAttachmentKey(attachment));
    if (mounted === undefined) return;
    mounted.activation?.release();
    this.#feedback.closePresentation(mounted.attachment.root);
    const current = this.#coordinator.getSnapshot().current;
    mounted.disposeScheme?.();
    mounted.disposeScheme = undefined;
    mounted.feedback.finish();
    delete mounted.initialLoading;
    mounted.savingFeedback = undefined;
    mounted.recovery?.close();
    mounted.recovery = undefined;
    mounted.loadError?.close();
    mounted.loadError = undefined;
    const scene = mounted.scene;
    if (
      scene !== undefined &&
      current?.documentId === mounted.attachment.documentId &&
      current.phase === "locked"
    ) {
      void scene.finishLock().then(() => {
        if (mounted.scene !== scene) return;
        scene.dispose();
        mounted.scene = undefined;
        this.#setState(attachment, "locked");
      });
      return;
    }
    scene?.dispose();
    mounted.scene = undefined;
    this.#setState(attachment, "locked");
  }
  #showAttachedRecovery(notice: {
    readonly attachmentGeneration: number;
    readonly attachmentId: string;
    readonly documentId: string;
  }): void {
    if (this.#disposed) return;
    this.#headlessRecovery?.close();
    this.#headlessRecovery = undefined;
    const mounted = this.#mounted.get(presentationAttachmentKey(notice));
    if (mounted === undefined) return;
    this.#feedback.closePresentation(mounted.attachment.root);
    mounted.savingFeedback?.finish();
    mounted.savingFeedback = undefined;
    mounted.scene?.restoreAfterFailedLock();
    mounted.recovery?.close();
    const recovery = showAttachedRecoveryPanel(
      mounted.attachment.root,
      {
        cancel: () => {
          if (!this.#coordinator.cancelAttachedRecovery()) return false;
          mounted.scene?.enableInput();
          this.#setState(mounted.attachment, "active");
          return true;
        },
        retry: () => {
          mounted.savingFeedback = mounted.feedback.begin("saving");
          const started = this.#coordinator.retryRecovery();
          if (!started) {
            mounted.savingFeedback.finish();
            mounted.savingFeedback = undefined;
          }
          return started;
        },
        saveLocalCopy: async () =>
          (
            await this.#coordinator.resolveRecovery("save-local-copy", {
              replaceMarkdownTarget: async (savedPath, isCurrent) => {
                const replaced = await this.#embedActions.replaceEmbedTarget(
                  mounted.attachment.embedReference,
                  savedPath,
                  isCurrent,
                );
                if (replaced && isCurrent()) {
                  this.#lifecycle.updateSavedCopyPreview(mounted, savedPath);
                }
                return replaced;
              },
            })
          ).confirmed,
      },
      () => {
        if (mounted.recovery === recovery) mounted.recovery = undefined;
      },
    );
    mounted.recovery = recovery;
  }
  #showLoadError(
    mounted: WorkspaceMountedPresentation,
    code: WorkspaceLoadFeedbackCode = "drawing-load-failed",
  ): void {
    this.#feedback.closePresentation(mounted.attachment.root);
    showWorkspaceLoadRecovery({
      activate: () => this.activate(mounted.attachment),
      discard: () => {
        if (!this.#coordinator.dismissLoadError()) this.#coordinator.requestLockCurrent();
        this.#setState(mounted.attachment, "locked");
      },
      isCurrent: () =>
        !this.#disposed &&
        this.#mounted.get(presentationAttachmentKey(mounted.attachment)) === mounted,
      mounted,
      code,
    });
  }

  #showHeadlessRecovery(documentId: string): void {
    if (this.#disposed || this.#host.openRecovery === undefined) return;
    this.#headlessRecovery?.close();
    this.#headlessRecovery = showWorkspaceHeadlessRecovery({
      coordinator: this.#coordinator,
      documentId,
      feedback: this.#feedback,
      openRecovery: this.#host.openRecovery,
    });
  }
  #owningWindow(documentId: string): Window {
    return this.#ownerWindows.require(documentId, this.#mounted.values(), this.#fallbackWindow);
  }
  readonly #fallbackWindow = (): Window | undefined =>
    resolveFallbackWindow(
      this.#coordinator.getSnapshot().current?.documentId,
      this.#mounted.values(),
      this.#ownerWindows,
      this.#fallbackOwnerWindow,
    );
}
