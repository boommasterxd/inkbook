import type { ScrollClassPort } from "./scroll-ports";

export const SCROLLBAR_STABILITY_CLASS = "inkbook-scrollbar-stable";

export interface ScrollbarLease {
  release(): void;
}

export class ScrollbarLeaseRegistry<ElementType extends object> {
  private readonly leaseCounts = new Map<ElementType, number>();

  public constructor(private readonly classes: ScrollClassPort<ElementType>) {}

  public acquire(element: ElementType): ScrollbarLease {
    const count = this.leaseCounts.get(element) ?? 0;
    if (count === 0) {
      this.classes.add(element, SCROLLBAR_STABILITY_CLASS);
    }
    this.leaseCounts.set(element, count + 1);

    let active = true;
    return {
      release: () => {
        if (!active) return;
        active = false;
        this.release(element);
      },
    };
  }

  public count(element: ElementType): number {
    return this.leaseCounts.get(element) ?? 0;
  }

  private release(element: ElementType): void {
    const count = this.leaseCounts.get(element);
    if (count === undefined) return;
    if (count > 1) {
      this.leaseCounts.set(element, count - 1);
      return;
    }
    this.leaseCounts.delete(element);
    this.classes.remove(element, SCROLLBAR_STABILITY_CLASS);
  }
}
