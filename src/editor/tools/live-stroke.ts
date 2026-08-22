import {
  buildStrokePath,
  pointDistance,
  roundCanonical,
  smoothStrokeCenters,
} from "../../domain/geometry/public";
import {
  buildCenterlineSlice,
  buildPressureOutlineSlice,
} from "../../domain/geometry/stroke-path-slice";
import type { StrokeStyleV1 } from "../../domain/schema/public";
import type {
  RawStrokeSample,
  StrokeInputOptions,
  StrokePathGeometry,
} from "../../domain/geometry/public";

const VALUES_PER_SAMPLE = 4;
const INITIAL_SAMPLE_CAPACITY = 16;
const MAX_SAMPLES = 4096;
const MAX_TAIL_SAMPLES = 16;
const BOUNDARY_SAMPLES = 4;
const FUTURE_SAMPLES = 5;

export interface LiveStrokeChunk {
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
  readonly finalizedChunkBuilds: number;
  readonly tailBuilds: number;
  readonly commitBuilds: number;
  readonly maximumTailSamples: number;
  readonly maximumFinalizedChunkSamples: number;
}

export interface LiveStrokeCommit {
  readonly points: number[];
  readonly geometry: StrokePathGeometry;
  readonly instrumentation: LiveStrokeInstrumentation;
}

export interface LiveStrokeBuilderOptions {
  readonly input: StrokeInputOptions;
  readonly style: StrokeStyleV1;
}

export class LiveStrokeBuilder {
  private buffer = new Float64Array(INITIAL_SAMPLE_CAPACITY * VALUES_PER_SAMPLE);
  private retainedSamples = 0;
  private finalizedSamples = 0;
  private readonly chunks: LiveStrokeChunk[] = [];
  private tail: LiveStrokePreview["tail"] | null = null;
  private finished = false;
  private appendedInputSamples = 0;
  private replacedTipSamples = 0;
  private bufferGrowths = 0;
  private finalizedChunkBuilds = 0;
  private tailBuilds = 0;
  private commitBuilds = 0;
  private maximumTailSamples = 0;
  private maximumFinalizedChunkSamples = 0;

  constructor(private readonly options: LiveStrokeBuilderOptions) {
    if (!Number.isFinite(options.input.zoom) || options.input.zoom <= 0) {
      throw new RangeError("Stroke zoom must be a positive finite number.");
    }
  }

  append(sample: RawStrokeSample): LiveStrokePreview {
    if (this.finished) throw new Error("A finished live stroke cannot accept samples.");
    this.assertSample(sample);
    this.appendedInputSamples += 1;
    if (this.shouldReplaceTip(sample) || this.retainedSamples === MAX_SAMPLES) {
      this.replaceTip(sample);
      this.replacedTipSamples += 1;
    } else {
      this.pushSample(sample);
    }
    this.finalizeStablePrefix();
    this.rebuildTail();
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
    const points = this.copyCanonicalPoints(0, this.retainedSamples);
    const geometry = this.buildGeometry(points);
    this.commitBuilds += 1;
    return { points, geometry, instrumentation: this.instrumentation() };
  }

  instrumentation(): LiveStrokeInstrumentation {
    return Object.freeze({
      appendedInputSamples: this.appendedInputSamples,
      retainedSamples: this.retainedSamples,
      replacedTipSamples: this.replacedTipSamples,
      bufferGrowths: this.bufferGrowths,
      finalizedChunkBuilds: this.finalizedChunkBuilds,
      tailBuilds: this.tailBuilds,
      commitBuilds: this.commitBuilds,
      maximumTailSamples: this.maximumTailSamples,
      maximumFinalizedChunkSamples: this.maximumFinalizedChunkSamples,
    });
  }

  private shouldReplaceTip(sample: RawStrokeSample): boolean {
    if (this.retainedSamples <= 1) return false;
    const tip = this.rawSample(this.retainedSamples - 1);
    return pointDistance(tip, sample) * this.options.input.zoom < 0.5;
  }

  private replaceTip(sample: RawStrokeSample): void {
    const index = this.retainedSamples - 1;
    this.writeSample(index, sample, this.resolvePressure(sample, index - 1));
  }

  private pushSample(sample: RawStrokeSample): void {
    if (this.retainedSamples === MAX_SAMPLES) {
      throw new RangeError("A stroke cannot contain more than 4096 retained samples.");
    }
    this.ensureCapacity(this.retainedSamples + 1);
    this.writeSample(
      this.retainedSamples,
      sample,
      this.resolvePressure(sample, this.retainedSamples - 1),
    );
    this.retainedSamples += 1;
  }

  private resolvePressure(sample: RawStrokeSample, previousIndex: number): number {
    if (this.options.input.pressureSource === "pen") {
      return Math.min(1, Math.max(0, sample.pressure));
    }
    if (previousIndex < 0) return 0.5;
    const previous = this.rawSample(previousIndex);
    const previousPressure = this.buffer[previousIndex * VALUES_PER_SAMPLE + 2] as number;
    const elapsed = Math.max(1, sample.time - previous.time);
    const speed = (pointDistance(previous, sample) * this.options.input.zoom) / elapsed;
    const target = Math.min(1, Math.max(0.25, 1 - speed / 1.5));
    return 0.7 * previousPressure + 0.3 * target;
  }

  private finalizeStablePrefix(): void {
    const tailStart = Math.max(0, this.finalizedSamples - BOUNDARY_SAMPLES);
    if (this.retainedSamples - tailStart <= MAX_TAIL_SAMPLES) return;
    const nextFinalized = this.retainedSamples - FUTURE_SAMPLES;
    const sampleCount = nextFinalized - this.finalizedSamples;
    const contextStart = Math.max(0, this.finalizedSamples - BOUNDARY_SAMPLES);
    this.chunks.push(
      Object.freeze({
        firstSample: this.finalizedSamples,
        sampleCount,
        geometry: this.buildSliceGeometry(
          contextStart,
          nextFinalized + BOUNDARY_SAMPLES,
          this.finalizedSamples === 0 ? null : this.finalizedSamples - 1,
          nextFinalized,
        ),
      }),
    );
    this.finalizedSamples = nextFinalized;
    this.finalizedChunkBuilds += 1;
    this.maximumFinalizedChunkSamples = Math.max(
      this.maximumFinalizedChunkSamples,
      nextFinalized + BOUNDARY_SAMPLES - contextStart,
    );
  }

  private rebuildTail(): void {
    const firstSample = Math.max(0, this.finalizedSamples - BOUNDARY_SAMPLES);
    const sampleCount = this.retainedSamples - firstSample;
    const boundarySamples = this.finalizedSamples - firstSample;
    this.tail = Object.freeze({
      firstSample,
      sampleCount,
      boundarySamples,
      geometry: this.buildSliceGeometry(
        firstSample,
        this.retainedSamples,
        this.finalizedSamples === 0 ? null : this.finalizedSamples - 1,
        null,
      ),
    });
    this.tailBuilds += 1;
    this.maximumTailSamples = Math.max(this.maximumTailSamples, sampleCount);
  }

  private buildGeometry(points: number[]): StrokePathGeometry {
    return buildStrokePath({
      id: "00000000-0000-4000-8000-000000000000",
      createdAt: 0,
      kind: "stroke",
      tool: this.options.style.pressureEnabled ? "pen" : "highlighter",
      points,
      rotation: 0,
      pivot: { x: 0, y: 0 },
      style: this.options.style,
    });
  }

  private buildSliceGeometry(
    contextStart: number,
    contextEnd: number,
    firstBoundary: number | null,
    lastBoundary: number | null,
  ): StrokePathGeometry {
    const points = this.copyCanonicalPoints(contextStart, contextEnd);
    const centers = smoothStrokeCenters(points);
    const slice = {
      firstBoundary: firstBoundary === null ? null : firstBoundary - contextStart,
      lastBoundary: lastBoundary === null ? null : lastBoundary - contextStart,
    };
    return this.options.style.pressureEnabled
      ? buildPressureOutlineSlice(centers, this.options.style.width, slice)
      : buildCenterlineSlice(centers, slice);
  }

  private copyCanonicalPoints(start: number, end: number): number[] {
    const points = new Array<number>((end - start) * 3);
    let output = 0;
    for (let index = start; index < end; index += 1) {
      const offset = index * VALUES_PER_SAMPLE;
      points[output] = roundCanonical(this.buffer[offset] as number);
      points[output + 1] = roundCanonical(this.buffer[offset + 1] as number);
      points[output + 2] = roundCanonical(this.buffer[offset + 2] as number, 4);
      output += 3;
    }
    return points;
  }

  private writeSample(index: number, sample: RawStrokeSample, pressure: number): void {
    const offset = index * VALUES_PER_SAMPLE;
    this.buffer[offset] = sample.x;
    this.buffer[offset + 1] = sample.y;
    this.buffer[offset + 2] = pressure;
    this.buffer[offset + 3] = sample.time;
  }

  private rawSample(index: number): RawStrokeSample {
    const offset = index * VALUES_PER_SAMPLE;
    return {
      x: this.buffer[offset] as number,
      y: this.buffer[offset + 1] as number,
      pressure: this.buffer[offset + 2] as number,
      time: this.buffer[offset + 3] as number,
    };
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
