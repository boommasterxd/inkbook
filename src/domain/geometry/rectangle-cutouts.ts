export interface PaintRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface CoverageEvent {
  readonly y: number;
  readonly start: number;
  readonly end: number;
  readonly delta: number;
}

/** Emits disjoint uncovered strips; overlapping cutouts never restore underlying paint. */
export function* rectangleCutoutsSteps(
  box: PaintRectangle,
  cutouts: readonly PaintRectangle[],
  options: { readonly maximumRectangles: number; readonly visit?: (() => void) | undefined },
): Generator<void, PaintRectangle[]> {
  const clipped: PaintRectangle[] = [];
  const coordinates = new Set([box.x, box.x + box.width]);
  for (const cutout of cutouts) {
    const clippedRectangle = intersectRectangle(box, cutout);
    if (clippedRectangle) {
      clipped.push(clippedRectangle);
      coordinates.add(clippedRectangle.x);
      coordinates.add(clippedRectangle.x + clippedRectangle.width);
    }
    yield;
  }
  if (!clipped.length) return box.width > 0 && box.height > 0 ? [box] : [];
  const xs = [...coordinates].sort((left, right) => left - right);
  const indexes = new Map(xs.map((value, index) => [value, index]));
  const events: CoverageEvent[] = [];
  for (const rectangle of clipped) {
    const interval = {
      start: indexes.get(rectangle.x)!,
      end: indexes.get(rectangle.x + rectangle.width)!,
    };
    events.push({ ...interval, y: rectangle.y, delta: 1 });
    events.push({ ...interval, y: rectangle.y + rectangle.height, delta: -1 });
    yield;
  }
  events.sort((left, right) => left.y - right.y);
  const coverage = new RectangleCoverage(xs, options.visit);
  const result: PaintRectangle[] = [];
  let top = box.y;
  let index = 0;
  while (index < events.length) {
    const y = events[index]!.y;
    yield* coverage.appendUncovered(top, y - top, result, options.maximumRectangles);
    while (index < events.length && events[index]!.y === y) {
      yield* coverage.update(events[index++]!);
    }
    top = y;
    yield;
  }
  yield* coverage.appendUncovered(top, box.y + box.height - top, result, options.maximumRectangles);
  return result;
}

function intersectRectangle(
  box: PaintRectangle,
  other: PaintRectangle,
): PaintRectangle | undefined {
  const x = Math.max(box.x, other.x);
  const y = Math.max(box.y, other.y);
  const right = Math.min(box.x + box.width, other.x + other.width);
  const bottom = Math.min(box.y + box.height, other.y + other.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}

/** Compressed x intervals bound update work independently of the number of earlier rectangles. */
class RectangleCoverage {
  readonly #counts: Int32Array;
  readonly #covered: Float64Array;
  public constructor(
    private readonly xs: readonly number[],
    private readonly visit: (() => void) | undefined,
  ) {
    this.#counts = new Int32Array(xs.length * 4);
    this.#covered = new Float64Array(xs.length * 4);
  }

  public *update(event: CoverageEvent): Generator<void> {
    yield* this.updateInterval(1, 0, this.xs.length - 1, event);
  }

  private *updateInterval(
    node: number,
    start: number,
    end: number,
    event: CoverageEvent,
  ): Generator<void> {
    this.visit?.();
    if (event.start <= start && end <= event.end) this.#counts[node]! += event.delta;
    else {
      const middle = Math.floor((start + end) / 2);
      if (event.start < middle) yield* this.updateInterval(node * 2, start, middle, event);
      if (event.end > middle) yield* this.updateInterval(node * 2 + 1, middle, end, event);
    }
    this.#covered[node] =
      this.#counts[node]! > 0
        ? this.xs[end]! - this.xs[start]!
        : end - start === 1
          ? 0
          : this.#covered[node * 2]! + this.#covered[node * 2 + 1]!;
    yield;
  }

  public *appendUncovered(
    y: number,
    height: number,
    rectangles: PaintRectangle[],
    maximum: number,
  ): Generator<void> {
    if (height <= 0) return;
    let pending: PaintRectangle | undefined;
    const append = (start: number, end: number) => {
      const x = this.xs[start]!;
      const right = this.xs[end]!;
      if (pending && pending.x + pending.width === x)
        pending = { ...pending, width: right - pending.x };
      else {
        if (pending) rectangles.push(pending);
        pending = { x, y, width: right - x, height };
      }
      if (rectangles.length >= maximum)
        throw new RangeError("Text background geometry exceeds its paint capacity.");
    };
    yield* this.uncovered(1, 0, this.xs.length - 1, append);
    if (pending) rectangles.push(pending);
  }

  private *uncovered(
    node: number,
    start: number,
    end: number,
    append: (start: number, end: number) => void,
  ): Generator<void> {
    this.visit?.();
    const width = this.xs[end]! - this.xs[start]!;
    if (this.#covered[node] === 0) append(start, end);
    else if (this.#covered[node]! < width) {
      const middle = Math.floor((start + end) / 2);
      yield* this.uncovered(node * 2, start, middle, append);
      yield* this.uncovered(node * 2 + 1, middle, end, append);
    }
    yield;
  }
}
