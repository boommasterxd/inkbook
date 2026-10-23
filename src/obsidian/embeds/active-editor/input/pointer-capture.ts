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

  public owns(pointerId: number): boolean {
    return this.#captured.has(pointerId);
  }

  public runIfOwned(pointerId: number, callback: () => void): void {
    if (this.owns(pointerId)) callback();
  }

  public release(pointerId: number): void {
    this.#captured.delete(pointerId);
    if (this.#surface.hasPointerCapture(pointerId)) this.#surface.releasePointerCapture(pointerId);
  }

  public releaseAll(): void {
    for (const pointerId of [...this.#captured]) this.release(pointerId);
  }
}
