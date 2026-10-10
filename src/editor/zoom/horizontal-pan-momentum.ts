import { estimateTouchPanVelocity } from "./touch-pan-velocity";

const SAMPLE_CAPACITY = 32;
const SAMPLE_WINDOW_MS = 120;
const MAX_STATIONARY_MS = 40;
const MIN_RELEASE_SPEED_PX_PER_SECOND = 50;
const MAX_RELEASE_SPEED_PX_PER_SECOND = 8_000;
const STOP_SPEED_PX_PER_SECOND = 15;
const TOUCH_FRICTION_PER_60_HZ_FRAME = 0.96;
const SIXTY_HZ_FRAME_MS = 1_000 / 60;
const DECAY_PER_SECOND = (-Math.log(TOUCH_FRICTION_PER_60_HZ_FRAME) * 1_000) / SIXTY_HZ_FRAME_MS;
const MAX_FRAME_GAP_MS = 100;

/**
 * Tracks horizontal pan velocity without allocating in the input or
 * animation-frame hot paths. Scheduling and camera clamping remain adapter-owned.
 */
export class HorizontalPanMomentum {
  readonly #positions = new Float64Array(SAMPLE_CAPACITY);
  readonly #times = new Float64Array(SAMPLE_CAPACITY);
  #active = false;
  #count = 0;
  #direction = 0;
  #lastFrameTime = 0;
  #lastMotionTime: number | undefined;
  #next = 0;
  #position = 0;
  #velocity = 0;

  public get active(): boolean {
    return this.#active;
  }

  public cancel(): void {
    this.#active = false;
    this.#resetSamples();
    this.#velocity = 0;
  }

  public record(screenDeltaX: number, timestamp: number): void {
    if (!Number.isFinite(screenDeltaX) || !validTime(timestamp)) return;
    const previous = this.#latestTime();
    if (previous !== undefined && timestamp < previous) {
      this.#resetSamples();
    }
    const direction = Math.sign(screenDeltaX);
    if (direction !== 0 && this.#direction !== 0 && direction !== this.#direction) {
      this.#resetSamples();
      if (previous !== undefined && previous <= timestamp) {
        this.#positions[0] = 0;
        this.#times[0] = previous;
        this.#count = 1;
        this.#next = 1;
      }
    }
    if (direction !== 0) {
      this.#direction = direction;
      this.#lastMotionTime = timestamp;
    }
    this.#position += screenDeltaX;
    if (this.#count > 0 && this.#latestTime() === timestamp) {
      this.#positions[(this.#next - 1 + SAMPLE_CAPACITY) % SAMPLE_CAPACITY] = this.#position;
      return;
    }
    this.#positions[this.#next] = this.#position;
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
    this.#resetSamples();
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
    const seconds = Math.min(
      elapsed / 1_000,
      Math.log(Math.abs(this.#velocity) / STOP_SPEED_PX_PER_SECOND) / DECAY_PER_SECOND,
    );
    const decay = Math.exp(-DECAY_PER_SECOND * seconds);
    const distance = (this.#velocity * (1 - decay)) / DECAY_PER_SECOND;
    this.#velocity *= decay;
    if (seconds < elapsed / 1_000 || Math.abs(this.#velocity) <= STOP_SPEED_PX_PER_SECOND)
      this.cancel();
    return distance;
  }

  #latestTime(): number | undefined {
    if (this.#count === 0) return undefined;
    return this.#times[(this.#next - 1 + SAMPLE_CAPACITY) % SAMPLE_CAPACITY];
  }

  #resetSamples(): void {
    this.#count = 0;
    this.#direction = 0;
    this.#lastMotionTime = undefined;
    this.#next = 0;
    this.#position = 0;
  }

  #releaseVelocity(now: number): number | undefined {
    const lastMotion = this.#lastMotionTime;
    if (
      lastMotion === undefined ||
      now < (this.#latestTime() ?? now) ||
      now - lastMotion > MAX_STATIONARY_MS
    ) {
      return undefined;
    }
    const start = (this.#next - this.#count + SAMPLE_CAPACITY) % SAMPLE_CAPACITY;
    let first = start;
    let count = 0;
    for (let offset = 0; offset < this.#count; offset += 1) {
      const index = (start + offset) % SAMPLE_CAPACITY;
      const time = this.#times[index] ?? 0;
      if (time > lastMotion || lastMotion - time > SAMPLE_WINDOW_MS) continue;
      if (count === 0) first = index;
      count += 1;
    }
    const velocity = estimateTouchPanVelocity(this.#positions, this.#times, first, count);
    // Allow only machine-rounding error at the inclusive release-speed boundary.
    const minimum = MIN_RELEASE_SPEED_PX_PER_SECOND * (1 - Number.EPSILON * 8);
    return velocity !== undefined && velocity * this.#direction >= minimum ? velocity : undefined;
  }
}

function validTime(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
