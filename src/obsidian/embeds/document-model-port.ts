import type { ArrangeAction } from "../../domain/commands/arrange";
import type { RenderBand } from "../../domain/commands/render-bands";
import type { InkElementV1, InkSnapshotV1 } from "../../domain/schema/public";
import type {
  AppliedElementMutation,
  ElementMutation,
  PreparedElementMutation,
  PreparedElementMutationResult,
  ElementStore,
  PreparedElementReplacement,
  PreparedElementReplacementResult,
  StoreSliceScheduler,
} from "../../domain/store/public";
import type {
  ClipboardCandidates,
  ClipboardWritePayload,
  PasteInvocation,
  PastePlan,
  PasteRepeatState,
} from "../../persistence/clipboard/public";
import type { AutosaveClock } from "../../persistence/saving/autosave/public";
import type { DocumentRuntimePort } from "../../persistence/worker/runtime/public";

export interface DocumentRuntimeFactories {
  clock(documentId: string): AutosaveClock;
  create(sessionId: string, workerEpoch: number, documentId: string): Promise<DocumentRuntimePort>;
  createFallback(
    sessionId: string,
    workerEpoch: number,
    isInputActive: () => boolean,
  ): DocumentRuntimePort;
  createStoreScheduler(documentId: string, isCancelled: () => boolean): StoreSliceScheduler;
  now(documentId: string): number;
}

export type DocumentMutationAvailability = "available" | "revision-exhausted";

export class DocumentRevisionExhaustedError extends RangeError {
  public constructor() {
    super("The document revision reached Number.MAX_SAFE_INTEGER.");
    this.name = "DocumentRevisionExhaustedError";
  }
}

export interface EditableDocumentModel {
  beginInteractiveOperation?(): () => void;
  waitForBackground?(): Promise<void>;
  readonly mutationAvailability: DocumentMutationAvailability;
  readonly page: InkSnapshotV1["page"];
  readonly revision: number;
  readonly store: ElementStore;
  commitBandOrder(order: Readonly<Record<RenderBand, readonly string[]>>): void;
  commitElement(element: InkElementV1): void;
  commitElements(elements: readonly InkElementV1[]): void;
  commitPage(page: InkSnapshotV1["page"]): void;
  prepareElementMutation(
    mutation: ElementMutation,
    cancellation: { isCancelled(): boolean; readonly replay?: AppliedElementMutation },
  ): Promise<PreparedElementMutationResult>;
  commitPreparedElementMutation(token: PreparedElementMutation): AppliedElementMutation | null;
  encodeClipboard(selectedIds: ReadonlySet<string>): Promise<ClipboardWritePayload | null>;
  planClipboardPaste(
    candidates: ClipboardCandidates,
    invocation: PasteInvocation,
    previousRepeat?: PasteRepeatState,
  ): Promise<PastePlan | null>;
  arrangeElements(ids: ReadonlySet<string>, action: ArrangeAction): void;
  removeElements(ids: readonly string[]): void;
  replaceElements(elements: readonly InkElementV1[]): void;
  prepareElementReplacement(
    replacements: readonly InkElementV1[],
    cancellation: { isCancelled(): boolean },
  ): Promise<PreparedElementReplacementResult>;
  commitPreparedElementReplacement(
    token: PreparedElementReplacement,
  ): "cancelled" | "committed" | "noop";
  setGestureActive(active: boolean): void;
  setNavigationActive?(active: boolean): void;
}
