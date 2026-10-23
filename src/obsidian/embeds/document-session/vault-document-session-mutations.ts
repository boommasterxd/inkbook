import type { ArrangeAction } from "../../../domain/commands/arrange";
import type { InkElementV1, InkSnapshotV1 } from "../../../domain/schema/public";
import type {
  AppliedElementMutation,
  ElementStore,
  ElementReplacementHistoryData,
  PreparedElementMutation,
  PreparedElementReplacement,
  StoreDelta,
} from "../../../domain/store/public";
import type { AutosaveCoordinator } from "../../../persistence/saving/autosave/public";
import { DocumentRevisionExhaustedError } from "./document-model-port";
import {
  commitVaultElementReplacement,
  commitVaultPage,
  recordVaultStoreDelta,
} from "./vault-document-model";

interface VaultDocumentSessionMutationOptions {
  readonly autosave: () => AutosaveCoordinator | undefined;
  readonly commitState: (state: {
    readonly page: InkSnapshotV1["page"];
    readonly revision: number;
  }) => void;
  readonly revision: () => number;
  readonly setRevision: (revision: number) => void;
  readonly store: () => ElementStore | undefined;
}

interface VaultMutationContext {
  readonly autosave: AutosaveCoordinator;
  readonly nextRevision: number;
  readonly store: ElementStore;
}

export class VaultDocumentSessionMutations {
  readonly #options: VaultDocumentSessionMutationOptions;

  public constructor(options: VaultDocumentSessionMutationOptions) {
    this.#options = options;
  }

  public arrangeElements(ids: ReadonlySet<string>, action: ArrangeAction): void {
    const context = this.#requireContext();
    if (context === undefined) return;
    const delta = context.store.arrange(ids, action);
    if (delta !== null) this.#recordDelta(context, delta);
  }

  public commitBandOrder(order: Parameters<ElementStore["reorderBands"]>[0]): void {
    const context = this.#requireContext();
    if (context === undefined) return;
    const delta = context.store.reorderBands(order);
    if (delta !== null) this.#recordDelta(context, delta);
  }

  public commitElements(elements: readonly InkElementV1[]): void {
    const context = this.#requireContext();
    if (context === undefined) return;
    const delta = context.store.create([...elements]);
    if (delta !== null) this.#recordDelta(context, delta);
  }

  public commitPage(page: InkSnapshotV1["page"]): void {
    const context = this.#requireContext();
    if (context === undefined) return;
    commitVaultPage({
      autosave: context.autosave,
      commit: this.#options.commitState,
      page,
      revision: this.#options.revision(),
      store: context.store,
    });
  }

  public commitPreparedElementMutation(
    token: PreparedElementMutation,
  ): AppliedElementMutation | null {
    const context = this.#requireContext();
    if (context === undefined) return null;
    const result = context.store.commitPreparedElementMutation(token);
    if (result.delta === null || result.transition === null) return null;
    this.#recordDelta(context, result.delta);
    return result.transition;
  }

  public commitPreparedElementReplacement(
    token: PreparedElementReplacement,
    capture?: (history: ElementReplacementHistoryData) => void,
  ): "cancelled" | "committed" | "noop" {
    const context = this.#requireContext();
    if (context === undefined) return "cancelled";
    return commitVaultElementReplacement({
      active: true,
      ...(capture === undefined ? {} : { capture }),
      recordDelta: (delta) => this.#recordDelta(context, delta),
      store: context.store,
      token,
    });
  }

  public removeElements(ids: readonly string[]): void {
    const context = this.#requireContext();
    if (context === undefined) return;
    const delta = context.store.remove([...ids]);
    if (delta !== null) {
      this.#recordDelta(context, delta);
    }
  }

  public replaceElements(
    elements: readonly InkElementV1[],
    capture?: (history: ElementReplacementHistoryData) => void,
  ): void {
    const context = this.#requireContext();
    if (context === undefined) return;
    let history: ElementReplacementHistoryData | undefined;
    const delta = context.store.replaceMany(elements, (committed) => {
      history = committed;
    });
    if (delta !== null) {
      this.#recordDelta(context, delta);
      if (history !== undefined) capture?.(history);
    }
  }

  #recordDelta(context: VaultMutationContext, delta: StoreDelta): void {
    this.#options.setRevision(context.nextRevision);
    recordVaultStoreDelta({
      autosave: context.autosave,
      delta,
      revision: context.nextRevision,
    });
  }

  #requireContext(): VaultMutationContext | undefined {
    const autosave = this.#options.autosave();
    const store = this.#options.store();
    if (autosave === undefined || store === undefined) return undefined;
    const revision = this.#options.revision();
    if (revision >= Number.MAX_SAFE_INTEGER) throw new DocumentRevisionExhaustedError();
    return { autosave, nextRevision: revision + 1, store };
  }
}
