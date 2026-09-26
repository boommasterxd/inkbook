import type { FileManager, Vault } from "obsidian";
import { normalizePath, TFile, TFolder } from "obsidian";

import type { SessionFactory, SessionIdentity } from "../../editor/session/session-port";
import type { DocumentRuntimeFactories, EditableDocumentModel } from "./document-model-port";
import { ObsidianVaultFileAdapter } from "../vault/file-adapter";
import {
  type SessionExternalChangeOutcome,
  type VaultDocumentSessionHooks,
} from "./vault-document-recovery";
import { VaultDocumentSession, type ActiveDocumentEditorContext } from "./vault-document-session";

export class VaultDocumentSessionFactory implements SessionFactory {
  readonly #runtimes: DocumentRuntimeFactories;
  readonly #files: ObsidianVaultFileAdapter;
  readonly #fileManager: FileManager;
  readonly #sessions = new Map<string, VaultDocumentSession>();
  readonly #hooks: VaultDocumentSessionHooks;

  constructor(
    vault: Vault,
    fileManager: FileManager,
    runtimes: DocumentRuntimeFactories,
    hooks: VaultDocumentSessionHooks = {},
  ) {
    this.#fileManager = fileManager;
    this.#runtimes = runtimes;
    this.#hooks = {
      ...hooks,
      persisted: (event) => {
        hooks.trustedHeads?.recordConfirmed(event);
        hooks.persisted?.(event);
      },
    };
    this.#files = new ObsidianVaultFileAdapter(
      vault,
      { file: TFile, folder: TFolder },
      normalizePath,
    );
  }

  create(identity: SessionIdentity): VaultDocumentSession {
    const session = new VaultDocumentSession(
      this.#fileManager,
      this.#runtimes,
      this.#files,
      identity,
      () => {
        if (this.#sessions.get(identity.sessionId) === session) {
          this.#sessions.delete(identity.sessionId);
        }
      },
      this.#hooks,
    );
    this.#sessions.set(identity.sessionId, session);
    return session;
  }

  getDocumentModel(sessionId: string): EditableDocumentModel | undefined {
    const model = this.#sessions.get(sessionId)?.documentModel;
    return model;
  }

  getEditorContext(sessionId: string): ActiveDocumentEditorContext | undefined {
    const context = this.#sessions.get(sessionId)?.editorContext;
    return context;
  }

  async notifyExternalChange(
    documentId: string,
    operation?: Parameters<VaultDocumentSession["notifyExternalChange"]>[0],
  ): Promise<SessionExternalChangeOutcome> {
    const sessions = [...this.#sessions.values()].filter(
      (session) => session.getSnapshot().documentId === documentId,
    );
    if (sessions.length !== 1) return "conflict";
    return sessions[0]!.notifyExternalChange(operation);
  }

  async prepareForUnload(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((session) => session.prepareForUnload()));
  }
}
