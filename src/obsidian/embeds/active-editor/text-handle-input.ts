import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { SelectionHandle } from "../../../editor/selection/public";
import type { ActiveTextSession } from "./text-session";
import type { ActiveEditorHandleInteraction } from "./previews/handle-interaction";
import type { ActiveEditorPointerController } from "./input/controller-pointer";
import type { ActivePointerCaptureOwner } from "./input/pointer-capture";
import type { ActiveEditorNavigation } from "./navigation/navigation";
import { TextHandleProjection } from "./text-handle-projection";

interface GeometryPointer {
  readonly down: PointerEvent;
  readonly projectedDown: PointerEvent;
  readonly handle: SelectionHandle;
  readonly projection: TextHandleProjection;
  readonly releaseListeners: () => void;
  latest: PointerEvent | undefined;
  terminal: "up" | "cancel" | undefined;
  ready: boolean;
  settling: boolean;
}

/** Transfers a real captured child pointer to the existing handle pipeline after source flush. */
export class TextHandleInput {
  #gesture: GeometryPointer | undefined;
  #disposed = false;
  public constructor(
    private readonly options: {
      readonly session: Pick<
        ActiveTextSession,
        "active" | "focusInput" | "suspendForGeometry" | "resumeAfterGeometry"
      > &
        Partial<Pick<ActiveTextSession, "inputElement">>;
      readonly coordinates?: () => ActiveTextSession["inputCoordinates"];
      readonly pointer: () => Pick<
        ActiveEditorPointerController,
        "handlePointerDown" | "handlePointerMove" | "handlePointerUp" | "cancelPointer"
      >;
      readonly handles: Pick<ActiveEditorHandleInteraction, "hitHandle" | "activePointerId">;
      readonly captures: ActivePointerCaptureOwner;
      readonly navigation: Pick<ActiveEditorNavigation, "pageSample" | "screenPointer">;
      readonly ownerWindow: Window;
      readonly scheduler: WorkScheduler;
    },
  ) {}

  public pointerDown(event: PointerEvent): boolean {
    if (this.#disposed || !this.options.session.active) return false;
    if (this.#gesture) return true;
    if (event.button !== 0 || (event.pointerType === "pen" && event.pressure === 0)) return false;
    const projection = new TextHandleProjection(
      event,
      this.options.ownerWindow,
      this.options.scheduler,
      this.options.coordinates?.(),
    );
    const projectedDown = projection.event(event);
    const pointer = this.options.navigation.pageSample(
      this.options.navigation.screenPointer(projectedDown),
    );
    const content = Boolean(
      (event.target as Element | null)?.closest?.(".cm-content,.inkbook-text-table-controls-layer"),
    );
    const handle = this.options.handles.hitHandle(pointer, content);
    if (!handle || (handle.kind !== "scale" && handle.kind !== "rotate")) {
      projection.dispose();
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!this.options.captures.captureFrom(event.pointerId, projection.document.documentElement)) {
      projection.dispose();
      this.options.session.focusInput();
      return true;
    }
    const gesture: GeometryPointer = {
      down: event,
      projectedDown,
      handle,
      projection,
      latest: undefined,
      terminal: undefined,
      ready: false,
      settling: false,
      releaseListeners: this.listen(projection.document),
    };
    this.#gesture = gesture;
    void this.start(gesture).catch(() => {
      if (this.#gesture !== gesture) return;
      if (gesture.ready) this.options.pointer().cancelPointer(gesture.down.pointerId);
      this.settled();
    });
    return true;
  }

  public settled(): void {
    const gesture = this.#gesture;
    if (!gesture || gesture.settling) return;
    gesture.settling = true;
    this.release(gesture);
    const finish = () => {
      if (this.#gesture === gesture) this.#gesture = undefined;
    };
    void this.options.session.resumeAfterGeometry().then(finish, finish);
  }

  public dispose(): void {
    this.#disposed = true;
    const gesture = this.#gesture;
    if (!gesture) return;
    this.#gesture = undefined;
    if (gesture.ready) this.options.pointer().cancelPointer(gesture.down.pointerId);
    this.release(gesture);
  }

  private async start(gesture: GeometryPointer): Promise<void> {
    if (
      !(await this.options.session.suspendForGeometry()) ||
      this.#gesture !== gesture ||
      this.#disposed
    ) {
      if (this.#gesture === gesture) this.settled();
      return;
    }
    if (gesture.terminal === "cancel") {
      this.settled();
      return;
    }
    gesture.ready = true;
    this.options.pointer().handlePointerDown(gesture.projectedDown, gesture.handle);
    if (this.options.handles.activePointerId !== gesture.down.pointerId) {
      this.settled();
      return;
    }
    if (gesture.latest)
      this.options.pointer().handlePointerMove(gesture.projection.event(gesture.latest));
    if (gesture.terminal === "up")
      this.options
        .pointer()
        .handlePointerUp(gesture.projection.event(gesture.latest ?? gesture.down));
  }

  private readonly move = (event: PointerEvent) => {
    const gesture = this.owned(event);
    if (!gesture || gesture.terminal) return;
    gesture.latest = event;
    if (gesture.ready) this.options.pointer().handlePointerMove(gesture.projection.event(event));
  };
  private readonly up = (event: PointerEvent) => this.finish(event, "up");
  private readonly cancel = (event: PointerEvent) => this.finish(event, "cancel");
  private readonly key = (event: KeyboardEvent) => {
    const gesture = this.#gesture;
    if (!gesture) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") this.finish(gesture.down, "cancel");
  };
  private readonly touch = (event: TouchEvent) => {
    if (this.#gesture) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  private finish(event: PointerEvent, terminal: "up" | "cancel"): void {
    const gesture = this.owned(event);
    if (!gesture || gesture.terminal) return;
    gesture.latest = event;
    gesture.terminal = terminal;
    if (!gesture.ready) return;
    if (terminal === "up") this.options.pointer().handlePointerUp(gesture.projection.event(event));
    else this.options.pointer().cancelPointer(event.pointerId);
  }

  private owned(event: PointerEvent): GeometryPointer | undefined {
    const gesture = this.#gesture;
    if (!gesture || gesture.settling || gesture.down.pointerId !== event.pointerId)
      return undefined;
    event.preventDefault();
    event.stopPropagation();
    return gesture;
  }
  private listen(document: Document): () => void {
    const entries = [
      ["pointermove", this.move],
      ["pointerup", this.up],
      ["pointercancel", this.cancel],
      ["lostpointercapture", this.cancel],
    ] as const;
    const keyboardDocuments = new Set([
      document,
      this.options.session.inputElement?.ownerDocument ?? document,
    ]);
    for (const [name, listener] of entries) document.addEventListener(name, listener, true);
    for (const owner of keyboardDocuments) owner.addEventListener("keydown", this.key, true);
    document.addEventListener("touchstart", this.touch, { capture: true, passive: false });
    document.addEventListener("touchmove", this.touch, { capture: true, passive: false });
    return () => {
      for (const [name, listener] of entries) document.removeEventListener(name, listener, true);
      for (const owner of keyboardDocuments) owner.removeEventListener("keydown", this.key, true);
      document.removeEventListener("touchstart", this.touch, true);
      document.removeEventListener("touchmove", this.touch, true);
    };
  }
  private release(gesture: GeometryPointer): void {
    gesture.releaseListeners();
    gesture.projection.dispose();
    this.options.captures.release(gesture.down.pointerId);
  }
}
