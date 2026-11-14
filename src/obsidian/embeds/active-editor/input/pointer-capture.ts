export interface PointerCaptureSurface {
  hasPointerCapture(pointerId: number): boolean;
  releasePointerCapture(pointerId: number): void;
  setPointerCapture(pointerId: number): void;
}

export class ActivePointerCaptureOwner {
  readonly #captured = new Set<number>();
  readonly #surface: PointerCaptureSurface;
  readonly #overrides = new Map<number, PointerCaptureSurface>();

  public constructor(surface: PointerCaptureSurface) {
    this.#surface = surface;
  }

  public capture(pointerId: number): void {
    if (this.#overrides.has(pointerId) && this.#captured.has(pointerId)) return;
    (this.#overrides.get(pointerId) ?? this.#surface).setPointerCapture(pointerId);
    this.#captured.add(pointerId);
  }

  public captureFrom(pointerId: number, surface: PointerCaptureSurface): boolean {
    try {
      surface.setPointerCapture(pointerId);
    } catch {
      return false;
    }
    this.#overrides.set(pointerId, surface);
    this.#captured.add(pointerId);
    return true;
  }

  public owns(pointerId: number): boolean {
    return this.#captured.has(pointerId);
  }

  public runIfOwned(pointerId: number, callback: () => void): void {
    if (this.owns(pointerId)) callback();
  }

  public release(pointerId: number): void {
    this.#captured.delete(pointerId);
    const surface = this.#overrides.get(pointerId) ?? this.#surface;
    this.#overrides.delete(pointerId);
    try {
      if (surface.hasPointerCapture(pointerId)) surface.releasePointerCapture(pointerId);
    } catch {
      /* A detached child may already have released native capture. */
    }
  }

  public releaseAll(): void {
    for (const pointerId of [...this.#captured]) this.release(pointerId);
  }
}
