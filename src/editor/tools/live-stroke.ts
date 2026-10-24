import type { PressureWindow } from "../../domain/geometry/pressure/pressure-window";
import { roundCanonical } from "../../domain/geometry/public";
import {
  LiveStrokeGeometry,
  LIVE_STROKE_WINDOW,
  MAX_LIVE_TAIL_SAMPLES,
} from "./live-stroke-geometry";
import { MAX_STROKE_POINTS, type StrokeStyleV1 } from "../../domain/schema/public";
import type {
  RawStrokeSample,
  StrokeInputOptions,
  StrokePathGeometry,
} from "../../domain/geometry/public";

const VALUES_PER_SAMPLE = 5;
const SIMULATED_SPEED_RESPONSE_MS = 32;
const INITIAL_SAMPLE_CAPACITY = 16;
const MAX_SAMPLES = MAX_STROKE_POINTS;

export interface LiveStrokeChunk {
  /** Raw input window that completed this immutable display chunk. */
  readonly firstSample: number;
  readonly sampleCount: number;
  readonly geometry: StrokePathGeometry;
}

export interface LiveStrokePreview {
  readonly finalizedChunks: readonly LiveStrokeChunk[];
  readonly tail: {
    readonly firstSample: number;
    readonly sampleCount: number;
    readonly boundarySamples: number;
    readonly geometry: StrokePathGeometry;
  };
}

export interface LiveStrokeInstrumentation {
  readonly appendedInputSamples: number;
  readonly retainedSamples: number;
  readonly replacedTipSamples: number;
  readonly bufferGrowths: number;
  readonly sampleBufferBytes: number;
  readonly finalizedChunkBuilds: number;
  readonly tailBuilds: number;
  readonly commitBuilds: number;
  readonly maximumTailSamples: number;
  readonly maximumFinalizedChunkSamples: number;
  readonly maximumPendingPressurePieces: number;
}

export interface LiveStrokeCommit {
  readonly points: number[];
  readonly geometry: StrokePathGeometry;
  readonly geometryMemoryBytes: number;
  readonly pressureWindows: readonly PressureWindow[] | undefined;
  readonly deferGeometryPreparation: boolean;
  readonly instrumentation: LiveStrokeInstrumentation;
}

export interface LiveStrokeBuilderOptions {
  readonly input: StrokeInputOptions;
  readonly style: StrokeStyleV1;
}

export class LiveStrokeBuilder {
  private buffer = new Float64Array(INITIAL_SAMPLE_CAPACITY * VALUES_PER_SAMPLE);
  private readonly canonicalPoints: number[] = [];
  private retainedSamples = 0;
  private mutableTipTravel = 0;
  private finalizedSamples = 0;
  private readonly chunks: LiveStrokeChunk[] = [];
  private tail: LiveStrokePreview["tail"] | null = null;
  private readonly geometry: LiveStrokeGeometry;
  private finished = false;
  private exhausted = false;
  private appendedInputSamples = 0;
  private replacedTipSamples = 0;
  private bufferGrowths = 0;
  private finalizedChunkBuilds = 0;
  private tailBuilds = 0;
  private commitBuilds = 0;
  private maximumTailSamples = 0;
  private maximumFinalizedChunkSamples = 0;

  constructor(private readonly options: LiveStrokeBuilderOptions) {
    this.geometry = new LiveStrokeGeometry(options.style);
    if (!Number.isFinite(options.input.zoom) || options.input.zoom <= 0) {
      throw new RangeError("Stroke zoom must be a positive finite number.");
    }
  }

  get capacityExhausted(): boolean {
    return this.exhausted;
  }

  append(sample: RawStrokeSample): LiveStrokePreview {
    return this.appendBatch([sample]);
  }

  appendBatch(samples: readonly RawStrokeSample[]): LiveStrokePreview {
    if (this.finished) throw new Error("A finished live stroke cannot accept samples.");
    if (samples.length === 0) return this.preview();
    let changed = false;
    for (const sample of samples) {
      this.assertSample(sample);
      this.appendedInputSamples += 1;
      if (this.exhausted) continue;
      if (this.shouldReplaceTip(sample)) {
        this.replaceTip(sample);
        this.replacedTipSamples += 1;
      } else if (this.retainedSamples === MAX_SAMPLES) {
        this.exhausted = true;
        continue;
      } else {
        this.pushSample(sample);
      }
      changed = true;
      this.finalizeStablePrefix();
    }
    if (changed) this.rebuildTail();
    return this.preview();
  }

  preview(): LiveStrokePreview {
    if (this.tail === null) throw new RangeError("A live stroke requires at least one sample.");
    return { finalizedChunks: this.chunks, tail: this.tail };
  }

  finish(): LiveStrokeCommit {
    if (this.finished) throw new Error("A live stroke can only be finished once.");
    if (this.retainedSamples === 0) throw new RangeError("A stroke requires at least one sample.");
    this.finished = true;
    const points = this.canonicalPoints;
    const builder = this.geometry;
    const deferGeometryPreparation = builder.prepareCommit();
    let cachedGeometry: StrokePathGeometry | undefined;
    this.commitBuilds += 1;
    return {
      points,
      get geometry() {
        return (cachedGeometry ??= builder.finish(points));
      },
      get pressureWindows() {
        return builder.pressureWindows(points);
      },
      deferGeometryPreparation,
      geometryMemoryBytes: points.length * 8 + builder.memoryUsage(),
      instrumentation: this.instrumentation(),
    };
  }

  instrumentation(): LiveStrokeInstrumentation {
    return Object.freeze({
      appendedInputSamples: this.appendedInputSamples,
      retainedSamples: this.retainedSamples,
      replacedTipSamples: this.replacedTipSamples,
      bufferGrowths: this.bufferGrowths,
      sampleBufferBytes: this.buffer.byteLength,
      finalizedChunkBuilds: this.finalizedChunkBuilds,
      tailBuilds: this.tailBuilds,
      commitBuilds: this.commitBuilds,
      maximumTailSamples: this.maximumTailSamples,
      maximumFinalizedChunkSamples: this.maximumFinalizedChunkSamples,
      maximumPendingPressurePieces: this.geometry.maximumPendingPressurePieces,
    });
  }

  private shouldReplaceTip(sample: RawStrokeSample): boolean {
    if (this.retainedSamples <= 1) return false;
    // Bound the whole replaced path, including reversals, instead of each event's movement.
    this.mutableTipTravel +=
      this.distanceToSample(this.retainedSamples - 1, sample) * this.options.input.zoom;
    return this.mutableTipTravel < 0.5;
  }

  private replaceTip(sample: RawStrokeSample): void {
    const index = this.retainedSamples - 1;
    this.writeSample(index, sample, index - 1);
  }

  private pushSample(sample: RawStrokeSample): void {
    if (this.retainedSamples === MAX_SAMPLES) {
      throw new RangeError(`A stroke cannot contain more than ${MAX_SAMPLES} retained samples.`);
    }
    this.ensureCapacity(this.retainedSamples + 1);
    this.writeSample(this.retainedSamples, sample, this.retainedSamples - 1);
    this.retainedSamples += 1;
    this.mutableTipTravel = 0;
  }

  private resolvePressure(sample: RawStrokeSample, previousIndex: number, speed: number): number {
    const pen = this.options.input.pressureSource === "pen";
    const measuredPressure = Math.min(1, Math.max(0, sample.pressure));
    if (previousIndex < 0) return pen ? measuredPressure : 0.5;
    const previousPressure = this.buffer[previousIndex * VALUES_PER_SAMPLE + 2] as number;
    const distance = this.distanceToSample(previousIndex, sample) * this.options.input.zoom;
    const target = pen ? measuredPressure : 1 / (1 + (speed / 0.35) ** 2);
    // A distance-based response suppresses slow pressure jitter without depending on event rate.
    const smoothingDistance = pen
      ? Math.max(2, 0.35 * this.options.style.width * this.options.input.zoom)
      : Math.max(4, 0.5 * this.options.style.width * this.options.input.zoom);
    const response = -Math.expm1(-distance / smoothingDistance);
    return previousPressure + response * (target - previousPressure);
  }

  private finalizeStablePrefix(): void {
    if (this.retainedSamples - this.finalizedSamples < MAX_LIVE_TAIL_SAMPLES) return;
    const geometry = this.geometry.finalize(this.canonicalPoints, this.finalizedSamples);
    if (geometry !== undefined) {
      this.chunks.push(
        Object.freeze({
          firstSample: this.finalizedSamples,
          sampleCount: LIVE_STROKE_WINDOW,
          geometry,
        }),
      );
      this.finalizedChunkBuilds += 1;
    }
    this.finalizedSamples += LIVE_STROKE_WINDOW;
    this.maximumFinalizedChunkSamples = Math.max(
      this.maximumFinalizedChunkSamples,
      MAX_LIVE_TAIL_SAMPLES,
    );
  }

  private rebuildTail(): void {
    const sampleCount = this.retainedSamples - this.finalizedSamples;
    this.tail = Object.freeze({
      firstSample: this.finalizedSamples,
      sampleCount,
      boundarySamples: Number(this.finalizedSamples > 0),
      geometry: this.geometry.preview(this.canonicalPoints, this.finalizedSamples),
    });
    this.tailBuilds += 1;
    this.maximumTailSamples = Math.max(this.maximumTailSamples, sampleCount);
  }

  private writeSample(index: number, sample: RawStrokeSample, previousIndex: number): void {
    const offset = index * VALUES_PER_SAMPLE;
    const stationary =
      this.options.input.pressureSource === "simulated" &&
      this.retainedSamples > 0 &&
      this.distanceToSample(this.retainedSamples - 1, sample) === 0;
    const latestOffset = (this.retainedSamples - 1) * VALUES_PER_SAMPLE;
    const speed = stationary
      ? (this.buffer[latestOffset + 4] as number)
      : this.resolveSpeed(sample, previousIndex);
    // Duplicate positions must not inflate pressure or shorten the next movement's elapsed time.
    const time = stationary ? (this.buffer[latestOffset + 3] as number) : sample.time;
    this.buffer[offset + 4] = speed;
    const pressure = stationary
      ? (this.buffer[latestOffset + 2] as number)
      : this.resolvePressure(sample, previousIndex, speed);
    this.buffer[offset] = sample.x;
    this.buffer[offset + 1] = sample.y;
    this.buffer[offset + 2] = pressure;
    this.buffer[offset + 3] = time;
    const canonicalOffset = index * 3;
    this.canonicalPoints[canonicalOffset] = roundCanonical(sample.x);
    this.canonicalPoints[canonicalOffset + 1] = roundCanonical(sample.y);
    this.canonicalPoints[canonicalOffset + 2] = roundCanonical(pressure, 4);
  }

  private resolveSpeed(sample: RawStrokeSample, previousIndex: number): number {
    if (this.options.input.pressureSource === "pen" || previousIndex < 0) return -1;
    const offset = previousIndex * VALUES_PER_SAMPLE;
    const elapsed = Math.max(1, sample.time - (this.buffer[offset + 3] as number));
    const speed =
      (this.distanceToSample(previousIndex, sample) * this.options.input.zoom) / elapsed;
    const previousSpeed = this.buffer[offset + 4] as number;
    if (previousSpeed < 0) return speed;
    // Filter velocity before the nonlinear pressure curve so timing jitter cannot bias nib width.
    const response = -Math.expm1(-elapsed / SIMULATED_SPEED_RESPONSE_MS);
    return previousSpeed + response * (speed - previousSpeed);
  }

  private distanceToSample(index: number, sample: RawStrokeSample): number {
    const offset = index * VALUES_PER_SAMPLE;
    return Math.hypot(
      (this.buffer[offset] as number) - sample.x,
      (this.buffer[offset + 1] as number) - sample.y,
    );
  }

  private ensureCapacity(requiredSamples: number): void {
    if (requiredSamples * VALUES_PER_SAMPLE <= this.buffer.length) return;
    const nextCapacity = Math.min(
      MAX_SAMPLES,
      Math.max(requiredSamples, (this.buffer.length / VALUES_PER_SAMPLE) * 2),
    );
    const next = new Float64Array(nextCapacity * VALUES_PER_SAMPLE);
    next.set(this.buffer.subarray(0, this.retainedSamples * VALUES_PER_SAMPLE));
    this.buffer = next;
    this.bufferGrowths += 1;
  }

  private assertSample(sample: RawStrokeSample): void {
    if (![sample.x, sample.y, sample.time].every(Number.isFinite)) {
      throw new RangeError("Stroke position and time must be finite.");
    }
    if (this.options.input.pressureSource === "pen" && !Number.isFinite(sample.pressure)) {
      throw new RangeError("Pen pressure must be finite.");
    }
  }
}
