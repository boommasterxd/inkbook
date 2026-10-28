import { rotatePointClockwise } from "../../../../domain/geometry/public";
import type { PointV1 } from "../../../../domain/schema/public";
import {
  SelectionHandleSession,
  selectionOverlayGeometry,
  type SelectionFrameSession,
  type SelectionHandle,
} from "../../../../editor/selection/public";
import type { ActiveEditorControllerOptions } from "../controller-types";
import type { ActiveEditorHandleInteraction } from "./handle-interaction";
import type { PreparedElementHistory } from "../prepared-element-history";
import { commitHandlePreview } from "./handle-preview-commit";
import { selectionHandleAction } from "./selection-handle-action";

export interface KeyboardHandleOptions {
  readonly controller: ActiveEditorControllerOptions;
  readonly handles: ActiveEditorHandleInteraction;
  readonly preparedHistory: PreparedElementHistory;
  readonly frames: SelectionFrameSession;
  readonly selection: () => ReadonlySet<string>;
  readonly zoom: () => number;
  readonly settled: (committed: boolean) => void;
}

/** Discrete keyboard edits use the same handle planner and commit path as pointer edits. */
export class KeyboardHandleInteraction {
  readonly #options: KeyboardHandleOptions;
  #session: SelectionHandleSession | undefined;
  #finish: ((committed: boolean) => void) | undefined;

  public constructor(options: KeyboardHandleOptions) {
    this.#options = options;
  }

  public get pending(): boolean {
    return this.#session !== undefined;
  }

  public choices(): readonly SelectionHandle[] {
    const selected = this.#options.handles.selectionGeometry();
    return (
      selectionOverlayGeometry(
        selected,
        this.#options.zoom(),
        null,
        this.#options.frames.current(selected),
      )?.handles ?? []
    );
  }

  public focus(index: number | null): void {
    this.#options.handles.setKeyboardFocus(index);
  }

  public cancel(): void {
    this.#session?.cancel();
    this.#finish?.(false);
    this.focus(null);
  }

  public step(index: number, delta: PointV1): void {
    if (this.pending) return;
    this.#finish?.(false);
    const { controller, frames, handles, preparedHistory } = this.#options;
    const selected = handles.selectionGeometry();
    if (selected.length === 0) return;
    const frame = frames.current(selected);
    const handle = index < 0 ? undefined : this.choices()[index];
    if (index >= 0 && handle === undefined) return;
    const action =
      handle === undefined
        ? { kind: "move" as const }
        : selectionHandleAction(handle, selected, frame);
    const start = handle?.point ?? { x: 0, y: 0 };
    const session = new SelectionHandleSession({
      action,
      elements: selected.map(({ element }) => element),
      planner: controller.model.store,
      preparedFrame: frame,
      startPointer: start,
      snap: {
        features: { angles: false, bends: false, connections: false, structures: false },
        pointerType: "mouse",
        spatial: controller.sceneStore,
        targets: { get: (id, bounds) => controller.sceneStore.getSnapTarget(id, bounds) },
        zoom: this.#options.zoom(),
      },
    });
    const target =
      action.kind === "rotate"
        ? rotatePointClockwise(start, action.center, delta.x || delta.y)
        : { x: start.x + delta.x, y: start.y + delta.y };
    let deferred = false;
    let completed = false;
    this.#session = session;
    const finish = (committed: boolean): void => {
      if (completed) return;
      completed = true;
      if (this.#session === session) this.#session = undefined;
      if (this.#finish === finish) this.#finish = undefined;
      controller.selectionMoveLayout.finish(committed);
      handles.renderSelection();
      this.#options.settled(committed);
    };
    this.#finish = finish;
    controller.selectionMoveLayout.begin();
    try {
      session.update(target);
      deferred = commitHandlePreview(
        {
          active: { frame, selectedIds: this.#options.selection(), session },
          history: controller.history,
          layout: { finish },
          preparedHistory,
          renderer: controller.renderer,
          selectionFrames: frames,
          previewMaximumBottom: undefined,
        },
        () => {
          if (this.#session === session) this.#session = undefined;
        },
      );
    } catch {
      session.cancel();
    } finally {
      if (!deferred) finish(false);
    }
  }
}

export function keyboardHandleName(handle: SelectionHandle | undefined): string {
  if (handle === undefined) return "Move";
  switch (handle.kind) {
    case "scale":
      return `Resize ${handle.position.replaceAll("-", " ")}`;
    case "rotate":
      return "Rotate";
    case "linear-endpoint":
      return `Line ${handle.endpoint}`;
    case "linear-bend":
      return "Line bend";
    case "coordinate-origin":
      return "Coordinate origin";
    case "coordinate-axis":
      return `Coordinate axis ${handle.axisIndex + 1}`;
    case "table-header":
      return "Table header";
    case "table-column":
      return `Table separator ${handle.separatorIndex + 1}`;
  }
}
