export interface PointerCaptureSurface {
  hasPointerCapture(pointerId: number): boolean;
  releasePointerCapture(pointerId: number): void;
  setPointerCapture(pointerId: number): void;
}

export class ActivePointerCaptureOwner {
  readonly #captured = new Set<number>();
  readonly #surface: PointerCaptureSurface;

  public constructor(surface: PointerCaptureSurface) {
    this.#surface = surface;
  }

  public capture(pointerId: number): void {
    this.#surface.setPointerCapture(pointerId);
    this.#captured.add(pointerId);
  }

  public release(pointerId: number): void {
    if (this.#surface.hasPointerCapture(pointerId)) this.#surface.releasePointerCapture(pointerId);
    this.#captured.delete(pointerId);
  }

  public releaseAll(): void {
    for (const pointerId of [...this.#captured]) this.release(pointerId);
  }
}
