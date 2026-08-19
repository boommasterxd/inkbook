export interface LayoutReadinessToken {
  readonly generation: number;
}

export class LayoutReadiness {
  private generation = 0;
  private ready = false;
  private valid = true;

  public capture(): LayoutReadinessToken | undefined {
    if (!this.valid || !this.ready) {
      return undefined;
    }

    return Object.freeze({ generation: this.generation });
  }

  public invalidate(): void {
    if (!this.valid) {
      return;
    }

    this.valid = false;
    this.ready = false;
    this.generation += 1;
  }

  public isCurrent(token: LayoutReadinessToken): boolean {
    return this.valid && this.ready && token.generation === this.generation;
  }

  public markReady(): LayoutReadinessToken | undefined {
    if (!this.valid) {
      return undefined;
    }

    if (!this.ready) {
      this.ready = true;
      this.generation += 1;
    }

    return this.capture();
  }
}
