import { browserScrollListeners, type BrowserScrollElement } from "../../scrolling/index";

interface ActiveSceneScrollBindingOptions {
  readonly initialOwner: BrowserScrollElement;
  readonly invalidate: () => void;
  readonly onScroll?: () => void;
  readonly ownerWindow: Window;
  readonly provider?: () => BrowserScrollElement | null;
  readonly reuseOwnScroll?: (owner: BrowserScrollElement) => boolean;
  readonly root: HTMLElement;
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
  applyToolbarScrollportPadding(options.root, owner, options.ownerWindow);
  const handleScroll = (): void => {
    synchronize();
    const reused = options.reuseOwnScroll?.(owner) === true;
    options.onScroll?.();
    if (!reused) options.invalidate();
  };
  let removeScrollListener = browserScrollListeners.listen(owner, handleScroll);
  const synchronize = (): void => {
    const current = options.provider?.();
    if (current === null || current === undefined || current === owner) return;
    removeScrollListener();
    owner = current;
    options.transfer(current);
    options.invalidate();
    applyToolbarScrollportPadding(options.root, owner, options.ownerWindow);
    removeScrollListener = browserScrollListeners.listen(current, handleScroll);
  };
  const handleResize = (): void => {
    synchronize();
    applyToolbarScrollportPadding(options.root, owner, options.ownerWindow);
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

function applyToolbarScrollportPadding(
  root: HTMLElement,
  owner: BrowserScrollElement,
  ownerWindow: Window,
): void {
  const parsed = Number.parseFloat(ownerWindow.getComputedStyle(owner).paddingTop);
  const padding = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  root.style.setProperty("--inkbook-toolbar-scrollport-padding", `${String(padding)}px`);
}
