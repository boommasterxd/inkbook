import type { PendingEditorChrome } from "./editor-chrome-loader";

export class InitialSceneReadiness {
  #layoutReady = false;
  #completed = false;

  /** Requests one fresh scene commit after the final initial layout is known. */
  public markLayoutReady(): boolean {
    if (this.#layoutReady) return false;
    this.#layoutReady = true;
    return true;
  }

  public markSceneCommitted(): boolean {
    if (this.#completed || !this.#layoutReady) return false;
    this.#completed = true;
    return true;
  }
}

export function createSceneReadiness(
  chrome: PendingEditorChrome,
  disposed: () => boolean,
  chromeMounted: () => void,
): { readonly ready: Promise<boolean>; readonly resolve: (ready: boolean) => void } {
  let resolve = (_ready: boolean): void => undefined;
  const layoutReady = new Promise<boolean>((complete) => {
    resolve = complete;
  });
  return {
    ready: chrome.ready.then((mounted) => {
      if (!mounted || disposed()) return false;
      chromeMounted();
      return layoutReady;
    }),
    resolve,
  };
}
