import { Notice, type FileManager, type Vault } from "obsidian";

import type { InkbookDeviceSettingsV1, InkbookSettingsV1 } from "../../domain/settings/types";
import type { PresentationLifecyclePort } from "../../editor/session/session-port";
import { WorkspaceEditorCoordinator } from "../../editor/session/workspace-editor-coordinator";
import type { AttachmentIdentity } from "../../editor/session/session-state";
import type { ColorSchemeBroadcaster } from "../theme/color-scheme";
import type { InkbookCommandAction, ObsidianEmbedActions } from "../commands";
import { ActiveInkbookScene } from "./active-scene";
import type { ActiveEditorViewState } from "./active-editor/navigation";
import { isLiveOwnerWindow, OwnerWindowRegistry } from "./owner-window-registry";
import {
  presentationAttachmentKey,
  presentationPreviewOptions,
  type PresentationAttachment,
  type PresentationSessionPort,
} from "./presentation-port";
import { WorkspaceRuntimeLifecycle } from "./workspace-runtime-lifecycle";
import { showWorkspaceLoadRecovery } from "./workspace-load-recovery";
import type { WorkspaceMountedPresentation } from "./workspace-load-recovery";
import { observeActiveSceneReadiness } from "./workspace-runtime-scene-readiness";
import { ownsMarkdownEditorChange } from "./workspace-runtime-editor";
import { createWorkspaceDocumentRuntimes } from "./workspace-runtime-workers";
import { copyWorkspaceEmbed, deleteWorkspaceEmbed } from "./workspace-embed-actions";
import { createHeadlessRecoveryActions } from "./workspace-recovery-actions";
import { VaultDocumentSessionFactory } from "./vault-document-session-factory";
import {
  showAttachedRecoveryPanel,
  showHeadlessRecoveryNotice,
  type HeadlessRecoveryNotice,
} from "./recovery-notice";
import { PresentationOperationFeedback } from "./presentation-operation-feedback";
import type { PresentationOperationFeedbackHandle } from "./presentation-operation-feedback";

export class ObsidianWorkspaceRuntime implements PresentationSessionPort {
  readonly #coordinator: WorkspaceEditorCoordinator;
  #disposed = false;
  readonly #embedActions: ObsidianEmbedActions;
  readonly #fallbackOwnerWindow: () => Window | undefined;
  #headlessRecovery: HeadlessRecoveryNotice | undefined;
  readonly #lifecycle: WorkspaceRuntimeLifecycle;
  readonly #ownerWindows = new OwnerWindowRegistry();
  readonly #mounted = new Map<string, WorkspaceMountedPresentation>();
  readonly #scheme: ColorSchemeBroadcaster;
  readonly #sessions: VaultDocumentSessionFactory;
  readonly #settings: () => {
    readonly device: InkbookDeviceSettingsV1;
    readonly vault: InkbookSettingsV1;
  };
  readonly #viewState = new Map<string, ActiveEditorViewState>();

  constructor(
    vault: Vault,
    fileManager: FileManager,
    scheme: ColorSchemeBroadcaster,
    settings: () => {
      readonly device: InkbookDeviceSettingsV1;
      readonly vault: InkbookSettingsV1;
    },
    embedActions: ObsidianEmbedActions,
    fallbackOwnerWindow: () => Window | undefined,
  ) {
    this.#embedActions = embedActions;
    this.#fallbackOwnerWindow = fallbackOwnerWindow;
    this.#scheme = scheme;
    this.#lifecycle = new WorkspaceRuntimeLifecycle({
      activate: (attachment, attempt) => this.#activate(attachment, attempt),
      fallbackWindow: () => this.#fallbackWindow(),
      isDisposed: () => this.#disposed,
      notifyExternalChange: (documentId) => this.#coordinator.notifyExternalChange(documentId),
      presentations: () => this.#mounted.values(),
      reloadPresentation: (documentId) => this.#reloadPresentation(documentId),
      vault,
    });
    this.#sessions = new VaultDocumentSessionFactory(
      vault,
      fileManager,
      createWorkspaceDocumentRuntimes({
        fallbackWindow: () => this.#fallbackWindow(),
        owningWindow: (documentId) => this.#owningWindow(documentId),
      }),
      {
        persisted: (event) => this.#lifecycle.handlePersisted(event),
      },
    );
    this.#settings = settings;
    const presentations: PresentationLifecyclePort = {
      cancelGesture: (attachment) =>
        this.#mounted.get(presentationAttachmentKey(attachment))?.scene?.disableInput(),
      disableInput: (attachment) => {
        const mounted = this.#mounted.get(presentationAttachmentKey(attachment));
        mounted?.scene?.disableInput();
        if (mounted !== undefined) {
          this.#viewState.delete(mounted.attachment.documentId);
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
    if (this.#mounted.has(key)) return;
    this.#mounted.set(key, {
      attachment,
      disposeScheme: undefined,
      feedback: new PresentationOperationFeedback(attachment.root),
      loadError: undefined,
      recovery: undefined,
      savingFeedback: undefined,
      scene: undefined,
    });
    this.#ownerWindows.observe(attachment.documentId, attachment.root.ownerDocument.defaultView);
    attachment.root.dataset.inkbookState = "locked";
    this.#coordinator.mountAttachment(attachment);
    this.#lifecycle.continueAutoActivation(attachment);
  }

  activate(attachment: PresentationAttachment): void {
    this.#activate(attachment);
  }

  #activate(attachment: PresentationAttachment, autoActivationAttempt?: number): void {
    if (this.#disposed) return;
    const mounted = this.#mounted.get(presentationAttachmentKey(attachment));
    if (mounted === undefined) return;
    mounted.loadError?.remove();
    mounted.loadError = undefined;
    const loadFeedback = mounted.savingFeedback ? undefined : mounted.feedback.begin("loading");
    this.#setState(attachment, "unlocking");
    const handle = this.#coordinator.requestActivation(attachment);
    void handle.outcome
      .then((outcome) => {
        if (outcome.kind !== "activated") {
          this.#lifecycle.failAutoActivation(attachment, autoActivationAttempt);
          const state = outcome.kind === "load-error" ? "load-error" : "locked";
          this.#setState(attachment, state, loadFeedback);
          if (outcome.kind === "load-error") this.#showLoadError(mounted);
          return;
        }
        if (outcome.phase !== "active") {
          this.#lifecycle.failAutoActivation(attachment, autoActivationAttempt);
          this.#setState(attachment, outcome.phase, loadFeedback);
          return;
        }
        const editorContext = this.#sessions.getEditorContext(outcome.sessionId);
        const current = this.#mounted.get(presentationAttachmentKey(attachment));
        if (editorContext === undefined || current !== mounted) {
          loadFeedback?.finish();
          this.#lifecycle.failAutoActivation(attachment, autoActivationAttempt);
          return;
        }
        mounted.scene?.dispose();
        mounted.disposeScheme?.();
        const initialScheme = attachment.root.dataset.inkbookScheme === "dark" ? "dark" : "light";
        const settings = this.#settings();
        const initialViewState = this.#viewState.get(attachment.documentId);
        mounted.scene = new ActiveInkbookScene({
          backgroundSpacing: () => this.#settings().vault.pageDefaults.backgroundSpacing,
          defaults: settings.vault.toolDefaults,
          deviceSettings: settings.device,
          history: editorContext.history,
          ...(initialViewState === undefined ? {} : { initialViewState }),
          model: editorContext.model,
          onLock: () => {
            this.lockActivePresentation();
          },
          onNotice: (message) => {
            new Notice(message);
          },
          onCopyEmbed: () => {
            void copyWorkspaceEmbed(this.#embedActions, attachment.embedReference);
          },
          onDeleteEmbed: () => {
            const invokingScene = mounted.scene;
            if (invokingScene === undefined) return;
            void deleteWorkspaceEmbed({
              actions: this.#embedActions,
              isCurrent: () =>
                this.#mounted.get(presentationAttachmentKey(attachment)) === mounted &&
                mounted.scene === invokingScene,
              reference: attachment.embedReference,
              scene: invokingScene,
            });
          },
          onFirstStrokeCommitted: () => {
            this.#lifecycle.markFirstStroke(attachment.documentId);
          },
          root: attachment.root,
          ...presentationPreviewOptions(attachment),
          scheme: initialScheme,
          scrollOwner: attachment.scrollOwner,
          startupTool: settings.vault.startupTool,
        });
        const scene = mounted.scene;
        mounted.disposeScheme = this.#scheme.subscribe((scheme) =>
          mounted.scene?.setScheme(scheme),
        );
        observeActiveSceneReadiness({
          isCurrent: () =>
            this.#mounted.get(presentationAttachmentKey(attachment)) === mounted &&
            mounted.scene === scene,
          mounted,
          onFailure: () => {
            this.#setState(attachment, "load-error", loadFeedback);
            this.#showLoadError(mounted);
            this.#lifecycle.failAutoActivation(attachment, autoActivationAttempt);
          },
          onReady: () => {
            this.#setState(attachment, "active", loadFeedback);
            this.#lifecycle.completeAutoActivation(attachment, autoActivationAttempt);
          },
          scene,
        });
      })
      .catch(() => {
        this.#setState(attachment, "load-error", loadFeedback);
        this.#showLoadError(mounted);
        this.#lifecycle.failAutoActivation(attachment, autoActivationAttempt);
      });
  }

  detach(attachment: PresentationAttachment): void {
    this.#coordinator.detachAttachment(attachment);
    this.#releaseScene(attachment);
    this.#mounted.delete(presentationAttachmentKey(attachment));
    this.#lifecycle.detachAutoActivation(attachment);
    this.#pruneOwnerWindows();
  }
  hasActivePresentation(): boolean {
    return this.#coordinator.getSnapshot().current?.phase === "active";
  }
  execute(action: InkbookCommandAction): void {
    if (action === "lock") {
      if (!this.lockActivePresentation()) throw new Error("No active Inkbook presentation.");
      return;
    }
    const scene = this.#activeScene();
    if (scene === undefined || !scene.isActionAvailable(action)) {
      throw new Error(`Inkbook action is unavailable: ${action}`);
    }
    scene.executeAction(action);
  }
  isAvailable(action: InkbookCommandAction): boolean {
    if (action === "lock") return this.hasActivePresentation();
    return this.#activeScene()?.isActionAvailable(action) ?? false;
  }

  readonly lockActivePresentation = (): boolean => this.#coordinator.requestLockCurrent();

  updateDeviceSettings(settings: InkbookDeviceSettingsV1): void {
    if (this.#disposed) return;
    for (const mounted of this.#mounted.values()) mounted.scene?.updateDeviceSettings(settings);
  }

  queueAutoActivation(
    documentId: string,
    ownerWindow: Window,
    onTimeout: (retry: () => void) => void,
    dismissUndoHint?: () => void,
  ): void {
    this.#lifecycle.queueAutoActivation(documentId, ownerWindow, onTimeout, dismissUndoHint);
  }

  readonly abortAutoActivation = (documentId: string): void =>
    this.#lifecycle.abortAutoActivation(documentId);

  readonly handleVaultModification = (documentId: string): void =>
    this.#lifecycle.handleVaultModification(documentId);
  handleMarkdownEditorChange(sourcePath: string, pane: HTMLElement): void {
    if (this.#disposed) return;
    const current = this.#coordinator.getSnapshot().current;
    if (current?.phase !== "active" || current.attachment === undefined) return;
    const mounted = this.#mounted.get(presentationAttachmentKey(current.attachment));
    if (mounted !== undefined && ownsMarkdownEditorChange(mounted.attachment, sourcePath, pane)) {
      mounted.scene?.recordMarkdownHistory();
    }
  }
  readonly prepareForQuit = (): Promise<void> => this.#sessions.prepareForUnload();
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifecycle.dispose();
    this.#headlessRecovery?.close();
    this.#headlessRecovery = undefined;
    this.#coordinator.dispose({ preparePersistence: true });
    for (const mounted of this.#mounted.values()) {
      mounted.disposeScheme?.();
      mounted.feedback.dispose();
      mounted.loadError?.remove();
      mounted.recovery?.remove();
      mounted.scene?.dispose();
      mounted.attachment.root.dataset.inkbookState = "locked";
    }
    this.#mounted.clear();
    this.#viewState.clear();
    this.#ownerWindows.clear();
  }

  #reloadPresentation(documentId: string): void {
    const current = this.#coordinator.getSnapshot().current;
    if (current?.documentId !== documentId || current.attachment === undefined) return;
    const mounted = this.#mounted.get(presentationAttachmentKey(current.attachment));
    if (mounted !== undefined) this.activate(mounted.attachment);
  }

  #releaseScene(attachment: AttachmentIdentity): void {
    const mounted = this.#mounted.get(presentationAttachmentKey(attachment));
    if (mounted === undefined) return;
    const current = this.#coordinator.getSnapshot().current;
    const viewState = mounted.scene?.getViewState();
    if (
      !this.#disposed &&
      current?.documentId === mounted.attachment.documentId &&
      current.phase === "active" &&
      viewState !== undefined
    ) {
      this.#viewState.clear();
      this.#viewState.set(mounted.attachment.documentId, viewState);
    }
    mounted.disposeScheme?.();
    mounted.disposeScheme = undefined;
    mounted.feedback.finish();
    mounted.savingFeedback = undefined;
    mounted.recovery?.remove();
    mounted.recovery = undefined;
    mounted.loadError?.remove();
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

  #activeScene(): ActiveInkbookScene | undefined {
    const attachment = this.#coordinator.getSnapshot().current?.attachment;
    return attachment === undefined
      ? undefined
      : this.#mounted.get(presentationAttachmentKey(attachment))?.scene;
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
    mounted.savingFeedback?.finish();
    mounted.savingFeedback = undefined;
    mounted.scene?.restoreAfterFailedLock();
    mounted.recovery?.remove();
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

  #showLoadError(mounted: WorkspaceMountedPresentation): void {
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
    });
  }

  #showHeadlessRecovery(documentId: string): void {
    if (this.#disposed) return;
    this.#headlessRecovery?.close();
    const actions = createHeadlessRecoveryActions(this.#coordinator, (savedPath) => {
      new Notice(`Inkbook saved the recovery copy to ${savedPath}.`);
    });
    this.#headlessRecovery = showHeadlessRecoveryNotice(
      documentId,
      actions,
      () => this.#owningWindow(documentId).document,
    );
  }

  #setState(
    attachment: AttachmentIdentity,
    state: string,
    feedback?: PresentationOperationFeedbackHandle,
  ): void {
    feedback?.finish();
    const mounted = this.#mounted.get(presentationAttachmentKey(attachment));
    if (mounted !== undefined) mounted.attachment.root.dataset.inkbookState = state;
  }

  #owningWindow(documentId: string): Window {
    for (const mounted of this.#mounted.values()) {
      if (mounted.attachment.documentId !== documentId) continue;
      const owningWindow = mounted.attachment.root.ownerDocument.defaultView ?? undefined;
      if (isLiveOwnerWindow(owningWindow)) return owningWindow;
    }
    const leasedWindow = this.#ownerWindows.resolve(documentId);
    if (leasedWindow !== undefined) return leasedWindow;
    const fallbackWindow = this.#fallbackWindow();
    if (fallbackWindow !== undefined) return fallbackWindow;
    throw new Error("The Inkbook presentation has no owning window.");
  }

  #fallbackWindow(): Window | undefined {
    const current = this.#coordinator.getSnapshot().current;
    if (current !== undefined) {
      for (const mounted of this.#mounted.values()) {
        if (mounted.attachment.documentId !== current.documentId) continue;
        const owningWindow = mounted.attachment.root.ownerDocument.defaultView ?? undefined;
        if (isLiveOwnerWindow(owningWindow)) return owningWindow;
      }
    }
    if (current !== undefined) {
      const leasedWindow = this.#ownerWindows.resolve(current.documentId);
      if (leasedWindow !== undefined) return leasedWindow;
    }
    for (const mounted of this.#mounted.values()) {
      const ownerWindow = mounted.attachment.root.ownerDocument.defaultView ?? undefined;
      if (isLiveOwnerWindow(ownerWindow)) return ownerWindow;
    }
    const fallbackWindow = this.#fallbackOwnerWindow();
    return isLiveOwnerWindow(fallbackWindow) ? fallbackWindow : undefined;
  }

  #pruneOwnerWindows(): void {
    const retained = new Set<string>();
    for (const mounted of this.#mounted.values()) retained.add(mounted.attachment.documentId);
    const current = this.#coordinator.getSnapshot().current;
    if (current !== undefined) retained.add(current.documentId);
    this.#ownerWindows.prune(retained);
  }
}
