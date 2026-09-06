import { buildStrokePath, roundCanonical, smoothStrokeCenters } from "../../domain/geometry/public";
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
  private readonly canonicalPoints: number[] = [];
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
    return this.appendBatch([sample]);
  }

  appendBatch(samples: readonly RawStrokeSample[]): LiveStrokePreview {
    if (this.finished) throw new Error("A finished live stroke cannot accept samples.");
    if (samples.length === 0) return this.preview();
    for (const sample of samples) {
      this.assertSample(sample);
      this.appendedInputSamples += 1;
      if (this.shouldReplaceTip(sample) || this.retainedSamples === MAX_SAMPLES) {
        this.replaceTip(sample);
        this.replacedTipSamples += 1;
      } else {
        this.pushSample(sample);
      }
      this.finalizeStablePrefix();
    }
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
    const points = this.canonicalPoints;
    const geometry = this.buildCommitGeometry(points);
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
    return this.distanceToSample(this.retainedSamples - 1, sample) * this.options.input.zoom < 0.5;
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
    const previousPressure = this.buffer[previousIndex * VALUES_PER_SAMPLE + 2] as number;
    const previousTime = this.buffer[previousIndex * VALUES_PER_SAMPLE + 3] as number;
    const elapsed = Math.max(1, sample.time - previousTime);
    const speed =
      (this.distanceToSample(previousIndex, sample) * this.options.input.zoom) / elapsed;
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

  private buildCommitGeometry(points: number[]): StrokePathGeometry {
    if (this.tail === null) throw new RangeError("A live stroke requires at least one sample.");
    if (this.chunks.length === 0) return this.tail.geometry;
    if (this.options.style.pressureEnabled && !usesDirectPressureOutline(points)) {
      return this.buildGeometry(points);
    }
    return this.options.style.pressureEnabled
      ? combinePressureGeometry(this.chunks, this.tail)
      : combineCenterlineGeometry(this.chunks, this.tail);
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
    return this.canonicalPoints.slice(start * 3, end * 3);
  }

  private writeSample(index: number, sample: RawStrokeSample, pressure: number): void {
    const offset = index * VALUES_PER_SAMPLE;
    this.buffer[offset] = sample.x;
    this.buffer[offset + 1] = sample.y;
    this.buffer[offset + 2] = pressure;
    this.buffer[offset + 3] = sample.time;
    const canonicalOffset = index * 3;
    this.canonicalPoints[canonicalOffset] = roundCanonical(sample.x);
    this.canonicalPoints[canonicalOffset + 1] = roundCanonical(sample.y);
    this.canonicalPoints[canonicalOffset + 2] = roundCanonical(pressure, 4);
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

function combineCenterlineGeometry(
  chunks: readonly LiveStrokeChunk[],
  tail: LiveStrokePreview["tail"],
): StrokePathGeometry {
  // Preview slices overlap one quadratic at stable boundaries to hide seams.
  // Removing only that overlap reconstructs the exact one-pass centerline.
  const paths = new Array<string>(chunks.length + 1);
  paths[0] = chunks[0]!.geometry.d;
  for (let index = 1; index < chunks.length; index += 1) {
    paths[index] = afterOverlappingQuadratic(chunks[index]!.geometry.d);
  }
  paths[chunks.length] = afterOverlappingQuadratic(tail.geometry.d);
  return { d: paths.join(""), paint: "stroke" };
}

function combinePressureGeometry(
  chunks: readonly LiveStrokeChunk[],
  tail: LiveStrokePreview["tail"],
): StrokePathGeometry {
  // Pressure slices also contain temporary boundary connectors. Reordering their
  // two sides without those connectors avoids rebuilding every outline pair.
  const paths = new Array<string>(chunks.length * 2 + 1);
  for (let index = 0; index < chunks.length; index += 1) {
    const d = chunks[index]!.geometry.d;
    const firstQuadratic = requireCommand(d, "Q");
    const endConnector = requireCommand(d, "L", firstQuadratic);
    paths[index] =
      index === 0
        ? d.slice(0, endConnector)
        : d.slice(requireCommand(d, "Q", firstQuadratic + 1), endConnector);
  }

  const tailPath = tail.geometry.d;
  const tailFirstQuadratic = requireCommand(tailPath, "Q");
  paths[chunks.length] = tailPath.slice(
    requireCommand(tailPath, "Q", tailFirstQuadratic + 1),
    tailPath.lastIndexOf("L"),
  );

  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const d = chunks[index]!.geometry.d;
    const firstQuadratic = requireCommand(d, "Q");
    const endConnector = requireCommand(d, "L", firstQuadratic);
    const firstReverseQuadratic = requireCommand(d, "Q", endConnector);
    const reverseStart = requireCommand(d, "Q", firstReverseQuadratic + 1);
    const reverseEnd = index === 0 ? d.length : d.lastIndexOf("L");
    paths[chunks.length * 2 - index] = d.slice(reverseStart, reverseEnd);
  }
  return { d: paths.join(""), paint: "fill" };
}

function afterOverlappingQuadratic(d: string): string {
  const firstQuadratic = requireCommand(d, "Q");
  return d.slice(requireCommand(d, "Q", firstQuadratic + 1));
}

function requireCommand(d: string, command: "L" | "Q", fromIndex = 0): number {
  const index = d.indexOf(command, fromIndex);
  if (index < 0) throw new Error(`Live stroke geometry is missing the ${command} command.`);
  return index;
}

function usesDirectPressureOutline(points: readonly number[]): boolean {
  const pointCount = points.length / 3;
  let previous = smoothedPointAt(points, 0, pointCount);
  for (let index = 0; index < pointCount; index += 1) {
    const center = index === 0 ? previous : smoothedPointAt(points, index, pointCount);
    if (index > 0 && center.x === previous.x && center.y === previous.y) return false;
    const next = smoothedPointAt(points, Math.min(pointCount - 1, index + 1), pointCount);
    const tangentLength = Math.hypot(next.x - previous.x, next.y - previous.y);
    if (tangentLength === 0 || !Number.isFinite(tangentLength)) return false;
    previous = center;
  }
  return true;
}

function smoothedPointAt(
  points: readonly number[],
  index: number,
  pointCount: number,
): { readonly x: number; readonly y: number } {
  const offset = index * 3;
  if (index === 0 || index === pointCount - 1) {
    return { x: points[offset]!, y: points[offset + 1]! };
  }
  return {
    x: points[offset - 3]! * 0.25 + points[offset]! * 0.5 + points[offset + 3]! * 0.25,
    y: points[offset - 2]! * 0.25 + points[offset + 1]! * 0.5 + points[offset + 4]! * 0.25,
  };
}
