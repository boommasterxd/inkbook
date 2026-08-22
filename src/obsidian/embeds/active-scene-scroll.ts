import { browserScrollListeners, type BrowserScrollElement } from "../scrolling/index";

interface ActiveSceneScrollBindingOptions {
  readonly initialOwner: BrowserScrollElement;
  readonly invalidate: () => void;
  readonly ownerWindow: Window;
  readonly provider?: () => BrowserScrollElement | null;
  readonly transfer: (owner: BrowserScrollElement) => void;
}

export interface ActiveSceneScrollBinding {
  current(): BrowserScrollElement;
  dispose(): void;
}

export function bindActiveSceneScrollOwner(
  options: ActiveSceneScrollBindingOptions,
): ActiveSceneScrollBinding {
  let owner = options.initialOwner;
  let removeScrollListener = browserScrollListeners.listen(owner, options.invalidate);
  const synchronize = (): void => {
    const current = options.provider?.();
    if (current === null || current === undefined || current === owner) return;
    removeScrollListener();
    owner = current;
    options.transfer(current);
    removeScrollListener = browserScrollListeners.listen(current, options.invalidate);
  };
  const handleResize = (): void => {
    synchronize();
    options.invalidate();
  };
  options.ownerWindow.addEventListener("resize", handleResize, { passive: true });
  return {
    current: () => {
      synchronize();
      return owner;
    },
    dispose: () => {
      removeScrollListener();
      options.ownerWindow.removeEventListener("resize", handleResize);
    },
  };
}
