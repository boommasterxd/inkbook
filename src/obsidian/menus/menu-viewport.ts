export function readMenuViewport(ownerWindow: Window): {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
} {
  const viewport = ownerWindow.visualViewport;
  if (viewport !== undefined && viewport !== null) {
    return {
      height: viewport.height,
      left: viewport.offsetLeft,
      top: viewport.offsetTop,
      width: viewport.width,
    };
  }
  return {
    height: ownerWindow.innerHeight,
    left: 0,
    top: 0,
    width: ownerWindow.innerWidth,
  };
}

/** Retains the unobstructed height while a keyboard reduces the same-width viewport. */
export class PhoneSheetHeight {
  #width: number | undefined;
  #unobstructedHeight = 0;

  public viewport(
    viewport: ReturnType<typeof readMenuViewport>,
    layoutHeight: number,
    keyboardHeight: number,
  ): ReturnType<typeof readMenuViewport> {
    this.#rememberHeight(viewport, layoutHeight);
    if (keyboardHeight <= 0) return viewport;
    return {
      ...viewport,
      height: Math.max(
        0,
        Math.min(viewport.height, this.#unobstructedHeight - keyboardHeight - viewport.top),
      ),
    };
  }

  public maximum(
    viewport: { readonly width: number; readonly height: number },
    layoutHeight: number,
    extraHeight = 0,
  ): number {
    this.#rememberHeight(viewport, layoutHeight);
    return Math.min(this.#unobstructedHeight * 0.6 + extraHeight, viewport.height);
  }

  #rememberHeight(
    viewport: { readonly width: number; readonly height: number },
    layoutHeight: number,
  ): void {
    const height = Math.max(viewport.height, layoutHeight);
    this.#unobstructedHeight =
      this.#width === viewport.width ? Math.max(this.#unobstructedHeight, height) : height;
    this.#width = viewport.width;
  }
}
