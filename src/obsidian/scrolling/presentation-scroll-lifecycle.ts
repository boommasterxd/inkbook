import type { FrameScheduler } from "./scroll-ports";
import type { ScrollbarLease, ScrollbarLeaseRegistry } from "./scrollbar-lease";

interface PresentationMeasurementPort<ElementType, MeasurementType> {
  apply(measurement: MeasurementType): void;
  read(owner: ElementType): MeasurementType;
}

export interface PresentationScrollLifecycleOptions<ElementType extends object, MeasurementType> {
  readonly leases: ScrollbarLeaseRegistry<ElementType>;
  readonly measurement: PresentationMeasurementPort<ElementType, MeasurementType>;
  readonly onOwnerTransferred?: (owner: ElementType, previousOwner: ElementType) => void;
  readonly resolveOwner: () => ElementType | null;
  readonly scheduler: FrameScheduler;
}

interface OwnedLease<ElementType> {
  readonly element: ElementType;
  readonly lease: ScrollbarLease;
}

export class PresentationScrollLifecycle<ElementType extends object, MeasurementType> {
  private current: OwnedLease<ElementType> | null = null;
  private pending: OwnedLease<ElementType> | null = null;
  private frame: number | null = null;
  private generation = 0;

  public constructor(
    private readonly options: PresentationScrollLifecycleOptions<ElementType, MeasurementType>,
  ) {}

  public mount(): boolean {
    if (this.current !== null) return false;
    const element = this.options.resolveOwner();
    if (element === null) return false;

    this.current = { element, lease: this.options.leases.acquire(element) };
    this.scheduleMeasurement(this.current, this.generation);
    return true;
  }

  public transferAfterLayoutChange(): void {
    if (this.current === null) return;
    this.cancelPendingTransfer();
    const generation = ++this.generation;
    this.frame = this.options.scheduler.request(() => this.beginTransfer(generation));
  }

  public unload(): void {
    this.generation += 1;
    this.cancelFrame();
    this.pending?.lease.release();
    this.pending = null;
    this.current?.lease.release();
    this.current = null;
  }

  public get owner(): ElementType | null {
    return this.current?.element ?? null;
  }

  private beginTransfer(generation: number): void {
    this.frame = null;
    if (generation !== this.generation || this.current === null) return;

    const element = this.options.resolveOwner();
    if (element === null || element === this.current.element) return;

    this.pending = { element, lease: this.options.leases.acquire(element) };
    this.frame = this.options.scheduler.request(() => this.completeTransfer(generation));
  }

  private completeTransfer(generation: number): void {
    this.frame = null;
    if (generation !== this.generation || this.pending === null) return;

    const measurement = this.options.measurement.read(this.pending.element);
    this.options.measurement.apply(measurement);
    const previous = this.current;
    this.current = this.pending;
    this.pending = null;
    if (previous !== null) {
      try {
        this.options.onOwnerTransferred?.(this.current.element, previous.element);
      } finally {
        previous.lease.release();
      }
    }
  }

  private scheduleMeasurement(owned: OwnedLease<ElementType>, generation: number): void {
    this.frame = this.options.scheduler.request(() => {
      this.frame = null;
      if (generation !== this.generation || this.current !== owned) return;
      const measurement = this.options.measurement.read(owned.element);
      this.options.measurement.apply(measurement);
    });
  }

  private cancelPendingTransfer(): void {
    this.cancelFrame();
    this.pending?.lease.release();
    this.pending = null;
  }

  private cancelFrame(): void {
    if (this.frame === null) return;
    this.options.scheduler.cancel(this.frame);
    this.frame = null;
  }
}
