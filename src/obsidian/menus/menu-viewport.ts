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
