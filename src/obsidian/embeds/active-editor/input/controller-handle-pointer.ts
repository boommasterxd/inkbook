import type { PointerSample } from "../../../../editor/input/index";
import type { SelectionHandle } from "../../../../editor/selection/public";
import type { ActiveEditorHandleInteraction } from "../previews/handle-interaction";
import type { ActiveEditorNavigation } from "../navigation/navigation";

interface HandlePointerPorts {
  readonly handles: Pick<
    ActiveEditorHandleInteraction,
    "pointerDown" | "pointerMove" | "pointerUp"
  >;
  readonly navigation: Pick<ActiveEditorNavigation, "finish" | "pageSample">;
  readonly beginHandlePointer: (pointerType: PointerSample["pointerType"]) => void;
  readonly finishHandlePointer: () => void;
  readonly capturePointer: (pointerId: number) => void;
  readonly releasePointer: (pointerId: number) => void;
  readonly setSnappingInverted?: (pointerId: number, inverted: boolean | null) => void;
}

export function beginHandlePointer(
  event: PointerEvent,
  pointer: PointerSample,
  ports: HandlePointerPorts,
  request: { readonly eligible: boolean; readonly preferredHandle: SelectionHandle | undefined },
): boolean {
  if (
    request.eligible &&
    ports.handles.pointerDown(
      pointer,
      event.shiftKey,
      event.altKey === true,
      request.preferredHandle,
    )
  ) {
    ports.beginHandlePointer(pointer.pointerType);
    ports.capturePointer(event.pointerId);
    if (event.cancelable) event.preventDefault();
    return true;
  }
  if (!request.preferredHandle) return false;
  ports.navigation.finish();
  ports.setSnappingInverted?.(event.pointerId, null);
  return true;
}

export function finishHandlePointer(
  event: PointerEvent,
  pointer: PointerSample,
  ports: HandlePointerPorts,
): boolean {
  // A pen release may already contain hover coordinates. Finish from the queued contact frame.
  const noncontactPen = event.pointerType === "pen" && event.pressure === 0 && event.buttons === 0;
  const finished = noncontactPen && ports.handles.pointerUp(event.pointerId);
  if (
    !finished &&
    (noncontactPen ||
      !ports.handles.pointerMove(
        ports.navigation.pageSample(pointer),
        event.shiftKey,
        event.altKey === true,
      ))
  )
    return false;
  if (!finished) ports.handles.pointerUp(event.pointerId);
  ports.releasePointer(event.pointerId);
  ports.finishHandlePointer();
  ports.setSnappingInverted?.(event.pointerId, null);
  if (event.cancelable) event.preventDefault();
  return true;
}
