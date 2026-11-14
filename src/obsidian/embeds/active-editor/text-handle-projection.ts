import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { TextEditingCoordinates } from "../../../rendering/scene/text-editing-geometry";

/** One gesture leases the public owning-frame origin, refreshed only after host layout changes. */
export class TextHandleProjection {
  readonly document: Document;
  readonly #frame: Element | null;
  readonly #coordinates: TextEditingCoordinates | undefined;
  #origin = { left: 0, top: 0 };
  #scheduled: number | undefined;
  readonly #refresh = () => {
    if (this.#scheduled !== undefined || this.#frame === null) return;
    this.#scheduled = this.scheduler.requestFrame(() => {
      this.#scheduled = undefined;
      this.read();
    }, "input");
  };

  public constructor(
    event: PointerEvent,
    private readonly ownerWindow: Window,
    private readonly scheduler: WorkScheduler,
    coordinates?: TextEditingCoordinates,
  ) {
    const target = event.target;
    this.document =
      target && "ownerDocument" in target
        ? ((target.ownerDocument as Document | null) ?? ownerWindow.document)
        : ownerWindow.document;
    this.#frame = (coordinates?.drawingDocument ?? this.document).defaultView?.frameElement ?? null;
    this.#coordinates = coordinates?.drawingDocument === this.document ? undefined : coordinates;
    this.read();
    ownerWindow.document.addEventListener("scroll", this.#refresh, true);
    ownerWindow.addEventListener("resize", this.#refresh);
  }

  public event(event: PointerEvent): PointerEvent {
    const origin = this.#origin;
    const point = this.#coordinates?.toDrawingPoint({ x: event.clientX, y: event.clientY });
    return new Proxy(event, {
      get(target, property) {
        if (property === "clientX") return (point?.x ?? target.clientX) + origin.left;
        if (property === "clientY") return (point?.y ?? target.clientY) + origin.top;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? (value.bind(target) as unknown) : value;
      },
    });
  }

  public dispose(): void {
    if (this.#scheduled !== undefined) this.scheduler.cancelFrame(this.#scheduled);
    this.ownerWindow.document.removeEventListener("scroll", this.#refresh, true);
    this.ownerWindow.removeEventListener("resize", this.#refresh);
  }

  private read(): void {
    const rect = this.#frame?.getBoundingClientRect();
    this.#origin = { left: rect?.left ?? 0, top: rect?.top ?? 0 };
  }
}
