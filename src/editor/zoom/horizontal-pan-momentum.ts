const SAMPLE_CAPACITY = 32;
const SAMPLE_WINDOW_MS = 120;
const MIN_RELEASE_SPEED_PX_PER_SECOND = 100;
const MAX_RELEASE_SPEED_PX_PER_SECOND = 4_000;
const STOP_SPEED_PX_PER_SECOND = 15;
const FRICTION_PER_60_HZ_FRAME = 0.935;
const SIXTY_HZ_FRAME_MS = 1_000 / 60;
const MAX_FRAME_GAP_MS = 100;

/**
 * Tracks horizontal pan velocity without allocating in the input or
 * animation-frame hot paths. Scheduling and camera clamping remain adapter-owned.
 */
export class HorizontalPanMomentum {
  readonly #deltas = new Float64Array(SAMPLE_CAPACITY);
  readonly #times = new Float64Array(SAMPLE_CAPACITY);
  #active = false;
  #count = 0;
  #lastFrameTime = 0;
  #next = 0;
  #velocity = 0;

  public get active(): boolean {
    return this.#active;
  }

  public cancel(): void {
    this.#active = false;
    this.#count = 0;
    this.#next = 0;
    this.#velocity = 0;
  }

  public record(screenDeltaX: number, timestamp: number): void {
    if (!Number.isFinite(screenDeltaX) || screenDeltaX === 0 || !validTime(timestamp)) return;
    const previous = this.#latestTime();
    if (previous !== undefined && timestamp < previous) {
      this.#count = 0;
      this.#next = 0;
    }
    this.#deltas[this.#next] = screenDeltaX;
    this.#times[this.#next] = timestamp;
    this.#next = (this.#next + 1) % SAMPLE_CAPACITY;
    this.#count = Math.min(this.#count + 1, SAMPLE_CAPACITY);
  }

  public release(sampleTimestamp: number, animationTimestamp = sampleTimestamp): boolean {
    this.#active = false;
    if (!validTime(sampleTimestamp) || !validTime(animationTimestamp)) {
      this.cancel();
      return false;
    }
    const velocity = this.#releaseVelocity(sampleTimestamp);
    this.#count = 0;
    this.#next = 0;
    if (velocity === undefined) {
      this.#velocity = 0;
      return false;
    }
    this.#velocity = Math.max(
      -MAX_RELEASE_SPEED_PX_PER_SECOND,
      Math.min(MAX_RELEASE_SPEED_PX_PER_SECOND, velocity),
    );
    this.#lastFrameTime = animationTimestamp;
    this.#active = true;
    return true;
  }

  public advance(timestamp: number): number {
    if (!this.#active || !validTime(timestamp)) return 0;
    const elapsed = timestamp - this.#lastFrameTime;
    if (elapsed <= 0) return 0;
    if (elapsed > MAX_FRAME_GAP_MS) {
      this.cancel();
      return 0;
    }
    this.#lastFrameTime = timestamp;
    this.#velocity *= Math.pow(FRICTION_PER_60_HZ_FRAME, elapsed / SIXTY_HZ_FRAME_MS);
    if (Math.abs(this.#velocity) < STOP_SPEED_PX_PER_SECOND) {
      this.cancel();
      return 0;
    }
    return this.#velocity * (elapsed / 1_000);
  }

  #latestTime(): number | undefined {
    if (this.#count === 0) return undefined;
    return this.#times[(this.#next - 1 + SAMPLE_CAPACITY) % SAMPLE_CAPACITY];
  }

  #releaseVelocity(now: number): number | undefined {
    const start = (this.#next - this.#count + SAMPLE_CAPACITY) % SAMPLE_CAPACITY;
    let firstTime: number | undefined;
    let lastTime: number | undefined;
    let distance = 0;
    for (let offset = 0; offset < this.#count; offset += 1) {
      const index = (start + offset) % SAMPLE_CAPACITY;
      const time = this.#times[index] ?? 0;
      if (time > now || now - time > SAMPLE_WINDOW_MS) continue;
      distance += this.#deltas[index] ?? 0;
      firstTime ??= time;
      lastTime = time;
    }
    if (firstTime === undefined || lastTime === undefined || lastTime <= firstTime)
      return undefined;
    const velocity = (distance * 1_000) / (lastTime - firstTime);
    return Math.abs(velocity) >= MIN_RELEASE_SPEED_PX_PER_SECOND ? velocity : undefined;
  }
}

function validTime(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
