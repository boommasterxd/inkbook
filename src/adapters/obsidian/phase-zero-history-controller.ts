import { invertedEffects, isolateHistory } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import type { Editor, MarkdownView } from "obsidian";

import type {
  HostDispatchIntentV1,
  HostEffectAcknowledgementV1,
  HostEffectDeliveryV1,
  HistoryEntryId,
  HostEffectId,
  HostEffectRecoveryPortV1,
  HostTransactionSequence,
  OperationId,
  ViewId,
} from "../../application/host-history";
import { HostHistoryCoordinatorV1 } from "../../application/host-history";
import type {
  PreparedForwardProbeRecord,
  RecoveryIndexedDbStore,
  RecoveryNoteKey,
} from "../recovery-indexed-db";
import { EditorInputProbe } from "../../input/phase-zero";
import {
  accessEditorViewV1,
  createEditorHistoryBridgeV1,
  type AvailableEditorHistoryBridgeV1,
} from "./editor-history";
import type { PhaseZeroViewRegistry } from "./views";

const MAX_HISTORY_SESSIONS = 32;

interface HistorySession {
  readonly coordinator: HostHistoryCoordinatorV1;
  readonly note: RecoveryNoteKey;
  readonly path: string;
  readonly prepared: Map<string, PreparedForwardProbeRecord>;
  nextSessionOrder: number;
}

export interface PhaseZeroHistoryControllerOptions {
  readonly getRecoveryStore: () => Promise<RecoveryIndexedDbStore | undefined>;
  readonly notice: (message: string) => void;
  readonly vaultIdentityHint: string;
  readonly views: PhaseZeroViewRegistry;
}

export class PhaseZeroHistoryController {
  readonly #options: PhaseZeroHistoryControllerOptions;
  readonly #attachments = new WeakMap<EditorView, ViewId>();
  readonly #editorProbes = new Map<ViewId, EditorInputProbe>();
  readonly #sessions = new Map<string, Promise<HistorySession>>();
  readonly #epochSessions = new Map<string, HistorySession>();
  readonly #blockedPaths = new Set<string>();
  readonly bridge: AvailableEditorHistoryBridgeV1;
  #nextIdentity = 1;
  #disposed = false;
  #deliveryTail: Promise<void> = Promise.resolve();

  public constructor(options: PhaseZeroHistoryControllerOptions) {
    this.#options = options;
    const bridge = createEditorHistoryBridgeV1(
      { invertedEffects, isolateHistory },
      {
        attachEditor: (view) => this.#attachEditor(view),
        detachEditor: (editorViewId) => this.#detachEditor(editorViewId),
        enqueueDelivery: (editorViewId, ownerViewId, delivery) => {
          this.#deliveryTail = this.#deliveryTail.then(() =>
            this.#deliver(editorViewId, ownerViewId, delivery),
          );
        },
        reportMalformed: (_editorViewId, reason) => {
          this.#options.notice(`Inkbook history probe blocked: ${reason}.`);
        },
        sequenceHighWater: (editorViewId, epoch) =>
          this.#epochSessions
            .get(epochKey(editorViewId, epoch))
            ?.coordinator.sequenceHighWater(editorViewId, epoch),
      },
    );
    if (bridge.kind !== "available") {
      throw new Error(
        `CodeMirror history capability unavailable: ${bridge.reason}`,
      );
    }
    this.bridge = bridge;
  }

  public canInsert(view: MarkdownView): boolean {
    return (
      !this.#disposed && view.getMode() !== "preview" && view.file !== null
    );
  }

  public async insertProbeAnnotation(
    editor: Editor,
    markdownView: MarkdownView,
  ): Promise<void> {
    if (!this.canInsert(markdownView)) return;
    const access = accessEditorViewV1(editor);
    if (access.kind !== "available") {
      this.#options.notice(
        `Inkbook history probe unavailable: ${access.reason}.`,
      );
      return;
    }
    const editorViewId = this.#attachments.get(access.view);
    const path = markdownView.file?.path;
    if (editorViewId === undefined || path === undefined) {
      this.#options.notice(
        "Inkbook history probe is not attached to this editor.",
      );
      return;
    }
    const pendingSession = this.#session(path);
    if (pendingSession === undefined) {
      this.#options.notice(
        "Inkbook annotation blocked: history session capacity exceeded.",
      );
      return;
    }
    const session = await pendingSession;
    if (!this.canInsert(markdownView)) return;
    const prepared = session.coordinator.prepare({
      effectId: this.#id("effect") as HostEffectId,
      historyEntryId: this.#id("entry") as HistoryEntryId,
      patch: { prior: session.coordinator.scene.annotation, replacement: "B" },
      viewId: editorViewId,
    });
    if (prepared.kind !== "prepared") {
      this.#options.notice(`Inkbook annotation blocked: ${prepared.reason}.`);
      return;
    }
    const stored = await this.#prepareRecovery(session, prepared.intent);
    if (!this.canInsert(markdownView)) return;
    if (!stored) {
      session.coordinator.cancelAdmission(
        prepared.envelope.effectId,
        prepared.envelope.historyEpoch,
      );
      this.#options.notice(
        "Inkbook annotation blocked: recovery prepare failed.",
      );
      return;
    }
    const transaction = this.bridge.transaction(prepared.envelope);
    if (transaction === null) {
      session.coordinator.cancelAdmission(
        prepared.envelope.effectId,
        prepared.envelope.historyEpoch,
      );
      this.#options.notice("Inkbook annotation blocked: invalid host effect.");
      return;
    }
    this.#epochSessions.set(
      epochKey(editorViewId, prepared.envelope.historyEpoch),
      session,
    );
    access.view.dispatch(transaction);
    await this.#deliveryTail;
  }

  public status(): string {
    const probes = [...this.#editorProbes.values()].map((probe) =>
      probe.report(),
    );
    const complete = probes.filter((report) => report.complete).length;
    const historyState =
      this.#blockedPaths.size === 0
        ? "history ready"
        : `history fail-closed for ${String(this.#blockedPaths.size)} note(s)`;
    return `History bridge available; ${historyState}; editors ${String(probes.length)}; complete input probes ${String(complete)}.`;
  }

  public settle(): Promise<void> {
    return this.#deliveryTail;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of this.#sessions.values()) {
      void pending.then((session) => {
        const hasReachableEffects =
          session.coordinator.snapshot().entries.length > 0;
        session.coordinator.disposeForReload(hasReachableEffects);
      });
    }
    this.#sessions.clear();
    this.#epochSessions.clear();
    this.#blockedPaths.clear();
  }

  #attachEditor(view: EditorView): {
    readonly editorViewId: ViewId;
    readonly ownerViewId: ViewId;
    readonly inputProbe: EditorInputProbe;
  } {
    const editorViewId = this.#id("editor") as ViewId;
    const inputProbe = new EditorInputProbe();
    this.#attachments.set(view, editorViewId);
    this.#editorProbes.set(editorViewId, inputProbe);
    return { editorViewId, inputProbe, ownerViewId: editorViewId };
  }

  #session(path: string): Promise<HistorySession> | undefined {
    let pending = this.#sessions.get(path);
    if (pending === undefined) {
      if (this.#sessions.size >= MAX_HISTORY_SESSIONS) return undefined;
      pending = this.#createSession(path);
      this.#sessions.set(path, pending);
    }
    return pending;
  }

  async #createSession(path: string): Promise<HistorySession> {
    const store = await this.#recoveryStore();
    const note = {
      markdownPath: path,
      vaultIdentityHint: this.#options.vaultIdentityHint,
    };
    const loaded =
      store === undefined
        ? ({ kind: "backend-unavailable" } as const)
        : await store.loadNote(note);
    const records = loaded.kind === "loaded" ? loaded.records : [];
    const reference: { current?: HistorySession } = {};
    const recovery: HostEffectRecoveryPortV1 = {
      record: (intent, acknowledgement) => {
        const current = reference.current;
        return current === undefined
          ? Promise.resolve(false)
          : this.#recordRecovery(current, intent, acknowledgement);
      },
    };
    const coordinator = new HostHistoryCoordinatorV1(
      {
        createOperationId: (): OperationId =>
          this.#id("operation") as OperationId,
        initialAnnotation: null,
        noteIdentity: {
          vaultIdHint: this.#options.vaultIdentityHint,
          vaultRelativeMarkdownPath: path,
        },
        onRelease: (entry): void => {
          reference.current?.prepared.delete(entry.historyEntryId);
        },
        recovery,
      },
      {
        hostEffectsMayBeReachable:
          store === undefined || loaded.kind !== "loaded" || records.length > 0,
      },
    );
    const session: HistorySession = {
      coordinator,
      nextSessionOrder:
        records.reduce(
          (maximum, record) => Math.max(maximum, record.sessionOrder),
          0,
        ) + 1,
      note,
      path,
      prepared: new Map(),
    };
    reference.current = session;
    if (coordinator.lease.kind === "blocked") this.#blockedPaths.add(path);
    return session;
  }

  async #prepareRecovery(
    session: HistorySession,
    intent: HostDispatchIntentV1,
  ): Promise<boolean> {
    const store = await this.#recoveryStore();
    if (store === undefined) return false;
    const record: PreparedForwardProbeRecord = {
      attemptId: intent.operationId,
      forwardPatch: JSON.stringify(intent.patch),
      inversePatch: JSON.stringify({
        prior: intent.patch.replacement,
        replacement: intent.patch.prior,
      }),
      kind: "prepared-forward",
      note: session.note,
      schemaVersion: 1,
      sessionOrder: session.nextSessionOrder,
    };
    const result = await store.prepareForward(record);
    if (result.kind !== "written" && result.kind !== "unchanged") return false;
    session.nextSessionOrder += 1;
    session.prepared.set(intent.historyEntryId, record);
    return true;
  }

  async #recordRecovery(
    session: HistorySession,
    intent: HostDispatchIntentV1,
    acknowledgement: HostEffectAcknowledgementV1,
  ): Promise<boolean> {
    const store = await this.#recoveryStore();
    if (store === undefined) return false;
    if (intent.direction === "forward") {
      const prepared = session.prepared.get(intent.historyEntryId);
      if (prepared === undefined) return false;
      const result = await store.recordForward({
        acknowledgement: toProbeAcknowledgement(acknowledgement),
        attemptId: prepared.attemptId,
        expectedSessionOrder: prepared.sessionOrder,
        note: session.note,
      });
      return result.kind === "written" || result.kind === "unchanged";
    }
    const result = await store.recordDirection({
      acknowledgement: toProbeAcknowledgement(acknowledgement),
      attemptId: intent.operationId,
      forwardPatch: JSON.stringify(intent.patch),
      inversePatch: JSON.stringify({
        prior: intent.patch.replacement,
        replacement: intent.patch.prior,
      }),
      kind:
        intent.direction === "undo"
          ? "host-recorded-undo"
          : "host-recorded-redo",
      note: session.note,
      schemaVersion: 1,
      sessionOrder: session.nextSessionOrder,
    });
    if (result.kind !== "written" && result.kind !== "unchanged") return false;
    session.nextSessionOrder += 1;
    return true;
  }

  async #recoveryStore(): Promise<RecoveryIndexedDbStore | undefined> {
    try {
      return await this.#options.getRecoveryStore();
    } catch {
      return undefined;
    }
  }

  async #deliver(
    editorViewId: ViewId,
    ownerViewId: ViewId,
    delivery: HostEffectDeliveryV1,
  ): Promise<void> {
    const pendingSession = this.#session(
      delivery.envelope.noteIdentity.vaultRelativeMarkdownPath,
    );
    if (pendingSession === undefined) {
      this.#options.notice(
        "Inkbook history effect blocked: history session capacity exceeded.",
      );
      return;
    }
    const session = await pendingSession;
    const result = await session.coordinator.deliver(
      editorViewId,
      ownerViewId,
      delivery,
    );
    if (result.kind === "accepted" || result.kind === "duplicate") {
      this.#options.views.render(session.path, result.scene.annotation);
      return;
    }
    if (session.coordinator.lease.kind === "blocked") {
      this.#blockedPaths.add(session.path);
    }
    this.#options.notice(`Inkbook history effect blocked: ${result.reason}.`);
  }

  #id(kind: string): string {
    const value = `${kind}-${String(this.#nextIdentity)}`;
    this.#nextIdentity += 1;
    return value;
  }

  #detachEditor(editorViewId: ViewId): void {
    this.#editorProbes.delete(editorViewId);
    const prefix = `${editorViewId}\u0000`;
    const sessions = new Set<HistorySession>();
    for (const [key, session] of this.#epochSessions) {
      if (!key.startsWith(prefix)) continue;
      this.#epochSessions.delete(key);
      sessions.add(session);
    }
    for (const session of sessions) {
      session.coordinator.closeOwner(editorViewId, true);
    }
  }
}

function epochKey(editorViewId: ViewId, epoch: number): string {
  return `${editorViewId}\u0000${String(epoch)}`;
}

function toProbeAcknowledgement(acknowledgement: HostEffectAcknowledgementV1): {
  readonly direction: "forward" | "inverse";
  readonly editorViewId: string;
  readonly effectId: string;
  readonly transactionSequence: HostTransactionSequence;
} {
  return {
    direction: acknowledgement.direction,
    editorViewId: acknowledgement.editorViewId,
    effectId: acknowledgement.effectId,
    transactionSequence: acknowledgement.transactionSequence,
  };
}
