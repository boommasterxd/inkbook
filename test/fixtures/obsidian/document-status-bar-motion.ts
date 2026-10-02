import { vi } from "vitest";

/** Observes actual layout and animation boundaries without running browser scheduling. */
export function documentStatusBarMotionFixture() {
  let callback: ResizeObserverCallback = () => undefined;
  let observed: Element | undefined;
  const observe = vi.fn((element: Element) => {
    observed = element;
  });
  const disconnect = vi.fn();
  const observer = { observe, disconnect, unobserve: vi.fn() };
  const construct = vi.fn();
  const previous = Object.getOwnPropertyDescriptor(window, "ResizeObserver");
  class Observer {
    public constructor(next: ResizeObserverCallback) {
      construct();
      callback = next;
      return observer;
    }
  }
  Object.defineProperty(window, "ResizeObserver", { configurable: true, value: Observer });
  const query = {
    matches: false,
    addEventListener: vi.fn(
      (_type: string, _listener: EventListenerOrEventListenerObject) => undefined,
    ),
    removeEventListener: vi.fn(
      (_type: string, _listener: EventListenerOrEventListenerObject) => undefined,
    ),
  };
  const matchMedia = vi
    .spyOn(window, "matchMedia")
    .mockReturnValue(query as unknown as MediaQueryList);
  const animations: {
    cancel: ReturnType<typeof vi.fn>;
    effect: { getComputedTiming: ReturnType<typeof vi.fn> };
    onfinish: (() => void) | null;
  }[] = [];
  const animate = vi.fn(() => {
    const animation = {
      cancel: vi.fn(),
      effect: { getComputedTiming: vi.fn((): { progress: number | null } => ({ progress: 0.5 })) },
      onfinish: null as (() => void) | null,
    };
    animations.push(animation);
    return animation as unknown as Animation;
  });
  return {
    animate,
    animations,
    construct,
    disconnect,
    observe,
    query,
    attach: (root: HTMLElement): void => {
      Object.defineProperty(root, "animate", { configurable: true, value: animate });
    },
    resize: (width: number, target = observed): void => {
      callback([{ target, contentRect: { width } } as ResizeObserverEntry], observer);
    },
    empty: (): void => callback([], observer),
    mediaChanged: (): void => {
      const listener = query.addEventListener.mock.calls[0]?.[1] as (() => void) | undefined;
      listener?.();
    },
    cleanup: (): void => {
      matchMedia.mockRestore();
      if (previous === undefined) Reflect.deleteProperty(window, "ResizeObserver");
      else Object.defineProperty(window, "ResizeObserver", previous);
    },
  };
}
