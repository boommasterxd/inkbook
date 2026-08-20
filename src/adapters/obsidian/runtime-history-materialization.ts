import type { ActionableHistoryEntrySnapshotV1 } from "../../application/host-history";
import type { HostHistoryMaterializationV1 } from "../../application/host-history/coordinator";
import { commandFailure, commandSuccess } from "../../application/note-session";
import type { CommandResultV1 } from "../../application/note-session";
import {
  HistoryMaterializationCoordinatorV1,
  materializeAnnotationPatchThroughSourceMapV1,
  type HistoryMaterializationWorkV1,
  type SourceMapGraphNodeV1,
} from "../../application/source-coordination";

export class RuntimeHistoryMaterializationV1 implements HostHistoryMaterializationV1 {
  readonly #coordinator = new HistoryMaterializationCoordinatorV1();
  readonly #entrySources = new Map<string, SourceMapGraphNodeV1>();
  #readCurrentSource: (() => SourceMapGraphNodeV1) | null = null;

  public bind(readCurrentSource: () => SourceMapGraphNodeV1): void {
    this.#readCurrentSource = readCurrentSource;
  }

  public get currentSource(): SourceMapGraphNodeV1 | null {
    return this.#readCurrentSource?.() ?? null;
  }

  public associate(
    entry: ActionableHistoryEntrySnapshotV1,
    source: SourceMapGraphNodeV1,
  ): void {
    this.#entrySources.set(entry.effectId, source);
  }

  public associateIdentity(
    effectId: string,
    source: SourceMapGraphNodeV1,
  ): void {
    this.#entrySources.set(effectId, source);
  }

  public reset(
    entries: readonly ActionableHistoryEntrySnapshotV1[],
    source: SourceMapGraphNodeV1 | null,
  ): void {
    for (const key of this.#entrySources.keys()) this.#coordinator.cancel(key);
    this.#entrySources.clear();
    if (source === null) return;
    for (const entry of entries) this.associate(entry, source);
  }

  public release(entry: ActionableHistoryEntrySnapshotV1): void {
    this.#entrySources.delete(entry.effectId);
    this.#coordinator.cancel(entry.effectId);
  }

  public materialize(
    entry: ActionableHistoryEntrySnapshotV1,
  ): Promise<
    import("../../application/note-session").CommandResultV1<ActionableHistoryEntrySnapshotV1>
  > {
    const source = this.#entrySources.get(entry.effectId);
    const readCurrentSource = this.#readCurrentSource;
    if (source === undefined || readCurrentSource === null) {
      return Promise.resolve(commandFailure("history-unavailable"));
    }
    return this.#coordinator
      .materialize({
        currentSource: readCurrentSource,
        entryKey: entry.effectId,
        input: { sourceGeneration: source, value: entry },
        materialize: async (work) => materializeEntry(work),
      })
      .then((result) => {
        if (result.ok) {
          this.#entrySources.set(entry.effectId, readCurrentSource());
        }
        return result;
      });
  }

  public dispose(): void {
    this.#coordinator.dispose();
    this.#entrySources.clear();
    this.#readCurrentSource = null;
  }
}

function materializeEntry(
  work: HistoryMaterializationWorkV1<ActionableHistoryEntrySnapshotV1>,
): CommandResultV1<ActionableHistoryEntrySnapshotV1> {
  const forward = materializeAnnotationPatchThroughSourceMapV1({
    offsetMap: work.offsetMap,
    patch: work.value.historyEntry.forward,
    priorUtf16Length: work.priorSnapshot.utf16Length,
    replacementUtf16Length: work.replacementSnapshot.utf16Length,
  });
  if (!forward.ok) return commandFailure("history-unavailable");
  const inverse = materializeAnnotationPatchThroughSourceMapV1({
    offsetMap: work.offsetMap,
    patch: work.value.historyEntry.inverse,
    priorUtf16Length: work.priorSnapshot.utf16Length,
    replacementUtf16Length: work.replacementSnapshot.utf16Length,
  });
  if (!inverse.ok) return commandFailure("history-unavailable");
  const prepared = materializeAnnotationPatchThroughSourceMapV1({
    offsetMap: work.offsetMap,
    patch: work.value.preparedForward.patch,
    priorUtf16Length: work.priorSnapshot.utf16Length,
    replacementUtf16Length: work.replacementSnapshot.utf16Length,
  });
  if (!prepared.ok) return commandFailure("history-unavailable");
  return commandSuccess(
    Object.freeze({
      ...work.value,
      historyEntry: Object.freeze({
        ...work.value.historyEntry,
        forward: forward.value,
        inverse: inverse.value,
      }),
      preparedForward: Object.freeze({
        ...work.value.preparedForward,
        patch: prepared.value,
      }),
    }),
  );
}
