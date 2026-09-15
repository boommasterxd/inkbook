declare function setImmediate(callback: () => void): void;

/** Deterministic checkpoint cadence with real wall-clock measurements of active slices. */
export class DomainComparisonScheduler {
  readonly samples: number[] = [];
  private checkpoints = 0;
  private started = 0;

  constructor(private readonly checkpointsPerSlice: number) {}

  start(): void {
    this.samples.length = 0;
    this.checkpoints = 0;
    this.started = performance.now();
  }

  shouldYield = (): boolean => ++this.checkpoints >= this.checkpointsPerSlice;

  yieldControl = async (): Promise<void> => {
    this.samples.push(performance.now() - this.started);
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.checkpoints = 0;
    this.started = performance.now();
  };

  finish(): void {
    this.samples.push(performance.now() - this.started);
  }
}
