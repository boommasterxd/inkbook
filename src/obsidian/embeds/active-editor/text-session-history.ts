import type { InkElementV1, TextElementV2 } from "../../../domain/schema/public";
import type { EditableDocumentModel } from "../document-session/document-model-port";
import { captureElementReplacementHistory, type ActiveEditorHistory } from "./history";

export function textHistoryNavigator(
  session: Parameters<typeof navigateTextHistory>[0],
  options: Parameters<typeof navigateTextHistory>[1],
  position: () => number | undefined,
): (redo: boolean) => void {
  return (redo) => {
    void navigateTextHistory(session, options, redo, position());
  };
}

/** A transferred native document is rebuilt through the normal source/history boundary. */
export async function replaceTextSessionDocument(
  session: Parameters<typeof navigateTextHistory>[0],
  position: number | undefined,
  disposed: () => boolean,
): Promise<void> {
  const id = session.activeId;
  if (id && (await session.finish()) && !disposed())
    await session.edit(id, position, { preserveLayout: true });
}

export async function navigateTextHistory(
  session: {
    readonly activeId: string | undefined;
    finish(): Promise<boolean>;
    edit(
      id: string,
      position?: number,
      options?: { readonly preserveLayout?: boolean },
    ): Promise<boolean>;
  },
  options: {
    readonly model: EditableDocumentModel;
    readonly history: ActiveEditorHistory;
    readonly isDisposed: () => boolean;
    readonly onError: (error: unknown) => void;
    readonly onStateChanged: () => void;
  },
  redo: boolean,
  position: number | undefined,
): Promise<void> {
  const id = session.activeId;
  if (!id || !(await session.finish())) return;
  if (options.model.store.get(id) === undefined) return;
  try {
    await (redo ? options.history.redoAsync() : options.history.undoAsync());
    if (!options.isDisposed() && options.model.store.get(id)?.element.kind === "text")
      await session.edit(id, position, { preserveLayout: true });
  } catch (error) {
    if (!options.isDisposed()) options.onError(error);
  }
  if (!options.isDisposed()) options.onStateChanged();
}

/** Retain the store's owned replacement payload, including its measured byte cost. */
export async function commitTextReplacement(
  model: EditableDocumentModel,
  history: Pick<ActiveEditorHistory, "isDisposed" | "isTraversing" | "registerApplied">,
  element: TextElementV2,
  signal: AbortSignal,
  beforeCommit?: () => boolean,
): Promise<boolean> {
  const previous = model.store.get(element.id)?.element;
  if (previous?.kind !== "text") return false;
  const revision = model.revision;
  const isCancelled = () =>
    signal.aborted || history.isDisposed || history.isTraversing || model.revision !== revision;
  const prepared = await model.prepareElementReplacement([element], { isCancelled });
  if (prepared.status === "noop") return !isCancelled();
  if (prepared.status !== "prepared" || prepared.token === null || isCancelled()) return false;
  const captured = captureElementReplacementHistory([previous as TextElementV2], [element]);
  if (beforeCommit?.() === false) return false;
  const result = model.commitPreparedElementReplacement(prepared.token, captured.capture);
  if (result === "noop") return true;
  if (result !== "committed") return false;
  const replay = async (replacement: typeof captured.previous) => {
    const basis = model.revision;
    const cancelled = () => history.isDisposed || model.revision !== basis;
    const next = await model.prepareElementReplacement(replacement as readonly InkElementV1[], {
      isCancelled: cancelled,
    });
    if (next.status !== "prepared" || next.token === null || cancelled()) return false;
    return model.commitPreparedElementReplacement(next.token) === "committed";
  };
  return history.registerApplied({
    payloadBytes: captured.payloadBytes,
    undo: () => replay(captured.previous),
    redo: () => replay(captured.replacements),
  });
}
