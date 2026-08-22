import type {
  FrameScheduler,
  ScrollClassPort,
  ScrollDocumentPort,
  ScrollListenerPort,
  ScrollMetricsPort,
} from "../../../../src/obsidian/scrolling";

export class FakeScrollElement {
  public readonly classes = new Set<string>();
  public readonly listeners = new Set<() => void>();
  public clientHeight = 100;
  public overflowY = "visible";
  public parent: FakeScrollElement | null = null;
  public scrollHeight = 100;
  public scrollTop = 0;

  public constructor(public readonly name: string) {}

  public emitScroll(): void {
    for (const listener of this.listeners) listener();
  }
}

export class FakeFrameScheduler implements FrameScheduler {
  private readonly callbacks = new Map<number, () => void>();
  private nextFrame = 1;

  public cancel(frame: number): void {
    this.callbacks.delete(frame);
  }

  public request(callback: () => void): number {
    const frame = this.nextFrame++;
    this.callbacks.set(frame, callback);
    return frame;
  }

  public runNext(): void {
    const entry = this.callbacks.entries().next().value as [number, () => void] | undefined;
    if (entry === undefined) throw new Error("No frame is pending");
    this.callbacks.delete(entry[0]);
    entry[1]();
  }

  public get pendingCount(): number {
    return this.callbacks.size;
  }
}

export function createFakePorts(scrollingElement: FakeScrollElement | null): {
  classes: ScrollClassPort<FakeScrollElement>;
  document: ScrollDocumentPort<FakeScrollElement>;
  listeners: ScrollListenerPort<FakeScrollElement>;
  metrics: ScrollMetricsPort<FakeScrollElement>;
} {
  return {
    classes: {
      add: (element, className) => element.classes.add(className),
      remove: (element, className) => element.classes.delete(className),
    },
    document: {
      getOverflowY: (element) => element.overflowY,
      getParent: (element) => element.parent,
      scrollingElement,
    },
    listeners: {
      listen: (element, listener) => {
        element.listeners.add(listener);
        return () => element.listeners.delete(listener);
      },
    },
    metrics: {
      getClientHeight: (element) => element.clientHeight,
      getScrollHeight: (element) => element.scrollHeight,
      getScrollTop: (element) => element.scrollTop,
      setScrollTop: (element, value) => {
        element.scrollTop = value;
        element.emitScroll();
      },
    },
  };
}
