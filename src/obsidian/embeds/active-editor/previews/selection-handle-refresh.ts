import type { ElementStore } from "../../../../domain/store/public";
import type { SelectionPreviewFrameScheduler } from "./selection-preview-contracts";

interface SelectionHandleRefreshOptions {
  readonly model: { readonly store: Pick<ElementStore, "subscribe"> };
  readonly selection: () => ReadonlySet<string>;
  readonly frameScheduler: SelectionPreviewFrameScheduler;
}

/** Refreshes selected geometry deltas through the owning input-frame scheduler. */
export function subscribeSelectionHandleRefresh(
  options: SelectionHandleRefreshOptions,
  invalidate: () => boolean,
  refresh: () => void,
): () => void {
  let frame: number | undefined;
  let disposed = false;
  const cancel = () => {
    if (frame === undefined) return;
    options.frameScheduler.cancelFrame(frame);
    frame = undefined;
  };
  const unsubscribe = options.model.store.subscribe((delta) => {
    const idle = invalidate();
    if (!idle) {
      cancel();
      return;
    }
    const selection = options.selection();
    const affected = delta.changes.some(
      (change) =>
        selection.has(change.id) && (change.after === null || change.domains.includes("geometry")),
    );
    if (!affected || frame !== undefined) return;
    let synchronous = false;
    const handle = options.frameScheduler.requestFrame(() => {
      synchronous = true;
      frame = undefined;
      if (!disposed) refresh();
    }, "input");
    if (!synchronous) frame = handle;
  });
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    cancel();
  };
}
