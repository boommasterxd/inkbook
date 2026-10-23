import type { DocumentSaveStatus } from "../../../editor/session/session-port";
import type { EditableDocumentModel } from "../document-session/document-model-port";
import {
  presentationAttachmentKey,
  type PresentationAttachment,
} from "../presentation/presentation-port";

export type WorkspaceDocumentSaveStatus = {
  readonly path: string;
  readonly status: DocumentSaveStatus;
} | null;

export interface WorkspaceDocumentSaveStatusSource {
  readonly current: () => WorkspaceDocumentSaveStatus;
  readonly subscribe: (listener: () => void) => () => void;
}

type SaveModel = Pick<EditableDocumentModel, "getSaveStatus" | "subscribeSaveStatus">;
type StatusAttachment = Pick<
  PresentationAttachment,
  "attachmentId" | "attachmentGeneration" | "documentId" | "root"
>;

/** One authoritative editor binding, filtered by the publicly active Markdown pane. */
export class WorkspaceDocumentStatus implements WorkspaceDocumentSaveStatusSource {
  readonly #listeners = new Set<() => void>();
  #binding:
    { attachment: StatusAttachment; model: SaveModel; pane: HTMLElement | undefined } | undefined;
  #unsubscribe: (() => void) | undefined;
  #pane: HTMLElement | null | undefined;
  #value: WorkspaceDocumentSaveStatus = null;
  #disposed = false;

  constructor(private readonly resolvePane?: (root: HTMLElement) => HTMLElement | undefined) {}

  readonly current = (): WorkspaceDocumentSaveStatus => this.#value;
  readonly subscribe = (listener: () => void): (() => void) => {
    if (!this.#disposed) this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  bind(attachment: StatusAttachment, model: SaveModel): void {
    if (this.#disposed) return;
    if (
      this.#binding?.model === model &&
      presentationAttachmentKey(this.#binding.attachment) === presentationAttachmentKey(attachment)
    )
      return;
    this.#unsubscribe?.();
    const binding = { attachment, model, pane: this.resolvePane?.(attachment.root) };
    this.#binding = binding;
    this.#unsubscribe = model.subscribeSaveStatus?.(() => {
      if (this.#binding === binding) this.#publish();
    });
    this.#publish();
  }

  detach(attachment: Pick<StatusAttachment, "attachmentId" | "attachmentGeneration">): void {
    if (
      this.#binding === undefined ||
      presentationAttachmentKey(this.#binding.attachment) !== presentationAttachmentKey(attachment)
    )
      return;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#binding = undefined;
    this.#publish();
  }

  setActivePane(pane: HTMLElement | null): void {
    if (this.#disposed) return;
    this.#pane = pane;
    this.#publish();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#binding = undefined;
    this.#pane = undefined;
    this.#value = null;
    this.#listeners.clear();
  }

  #publish(): void {
    const binding = this.#binding;
    const status = binding?.model.getSaveStatus?.();
    if (
      binding !== undefined &&
      binding.pane === undefined &&
      this.#pane?.contains(binding.attachment.root)
    )
      binding.pane = this.#pane;
    const visible =
      binding !== undefined && (this.#pane === undefined || this.#pane === binding.pane);
    const value =
      visible && status !== undefined ? { path: binding.attachment.documentId, status } : null;
    if (value?.path === this.#value?.path && value?.status === this.#value?.status) return;
    this.#value = value;
    for (const listener of this.#listeners) listener();
  }
}
