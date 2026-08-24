import type { BackgroundV1, PageV1 } from "../../domain/schema/public";
import { centeredGuideAxis, roundCanonical } from "../../domain/geometry/public";

export interface BackgroundGeometryRequest {
  readonly background: BackgroundV1;
  readonly innerWidth: number;
  readonly margin: number;
  readonly visibleBottom: number;
  readonly visibleTop: number;
  readonly writableBottom: number;
}

export interface BackgroundGeometryResult {
  readonly d: string;
  readonly firstVisibleIndex: number;
  readonly hit: boolean;
  readonly lastVisibleIndex: number;
  readonly paint: "direct" | "none" | "pattern";
  readonly patternX: number;
  readonly patternY: number;
}

interface BackgroundCacheEntry extends BackgroundGeometryResult {
  readonly key: string;
}

const MAXIMUM_DIRECT_GUIDE_SEGMENTS = 2_048;

export class SceneBackgroundCache {
  #builds = 0;
  #entry: BackgroundCacheEntry | undefined;
  #hits = 0;

  public get builds(): number {
    return this.#builds;
  }

  public get hits(): number {
    return this.#hits;
  }

  public resolve(request: BackgroundGeometryRequest): BackgroundGeometryResult {
    if (request.background.type === "none") return this.resolveNone(request);
    const spacing = request.background.spacing;
    const viewportHeight = Math.max(0, request.visibleBottom - request.visibleTop);
    const writableBottom = Math.max(request.margin, request.writableBottom);
    const horizontal = centeredGuideAxis(request.margin, request.innerWidth, spacing);
    const vertical = centeredGuideAxis(request.margin, writableBottom - request.margin, spacing);
    const maximumIndex = vertical.intervalCount;
    const firstVisibleIndex = Math.min(
      maximumIndex,
      Math.max(0, Math.floor((request.visibleTop - viewportHeight - vertical.start) / spacing)),
    );
    const lastVisibleIndex = Math.min(
      maximumIndex,
      Math.max(
        firstVisibleIndex,
        Math.ceil((request.visibleBottom + viewportHeight - vertical.start) / spacing),
      ),
    );
    const key = [
      request.background.type,
      spacing,
      request.innerWidth,
      request.margin,
      writableBottom,
      horizontal.start,
      horizontal.end,
      vertical.start,
      vertical.end,
      firstVisibleIndex,
      lastVisibleIndex,
    ].join(":");
    if (this.#entry?.key === key) {
      this.#hits += 1;
      return { ...this.#entry, hit: true };
    }

    const visibleRows = lastVisibleIndex - firstVisibleIndex + 1;
    const directSegments =
      visibleRows + (request.background.type === "squares" ? horizontal.intervalCount + 1 : 0);
    const paint =
      request.background.type !== "dots" && directSegments <= MAXIMUM_DIRECT_GUIDE_SEGMENTS
        ? "direct"
        : "pattern";
    const d = buildBackgroundPath(
      paint,
      spacing,
      request.background.type === "squares",
      {
        bottom: vertical.end,
        left: request.background.type === "lines" ? request.margin : horizontal.start,
        right:
          request.background.type === "lines"
            ? request.margin + request.innerWidth
            : horizontal.end,
        top: vertical.start,
      },
      firstVisibleIndex,
      lastVisibleIndex,
    );
    this.#builds += 1;
    this.#entry = {
      d,
      firstVisibleIndex,
      hit: false,
      key,
      lastVisibleIndex,
      paint,
      patternX: horizontal.start,
      patternY: vertical.start,
    };
    return this.#entry;
  }

  public clear(): void {
    this.#entry = undefined;
  }

  public resetStatistics(): void {
    this.#builds = 0;
    this.#hits = 0;
  }

  private resolveNone(request: BackgroundGeometryRequest): BackgroundGeometryResult {
    const key = `none:${request.innerWidth}:0:0`;
    if (this.#entry?.key === key) {
      this.#hits += 1;
      return { ...this.#entry, hit: true };
    }
    this.#builds += 1;
    this.#entry = {
      d: "",
      firstVisibleIndex: 0,
      hit: false,
      key,
      lastVisibleIndex: 0,
      paint: "none",
      patternX: request.margin,
      patternY: request.margin,
    };
    return this.#entry;
  }
}

interface BackgroundCoverageBounds {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

function buildBackgroundPath(
  paint: "direct" | "pattern",
  spacing: number,
  includeVertical: boolean,
  bounds: BackgroundCoverageBounds,
  firstIndex: number,
  lastIndex: number,
): string {
  const top = canonical(bounds.top + firstIndex * spacing);
  const lastGuide = canonical(Math.min(bounds.bottom, bounds.top + lastIndex * spacing));
  if (paint === "direct") {
    const guides: string[] = [];
    for (let index = firstIndex; index <= lastIndex; index += 1) {
      const y = canonical(Math.min(bounds.bottom, bounds.top + index * spacing));
      guides.push(`M ${canonical(bounds.left)} ${y} L ${canonical(bounds.right)} ${y}`);
    }
    if (includeVertical) {
      for (let x = bounds.left; x <= bounds.right; x += spacing) {
        guides.push(`M ${canonical(x)} ${top} L ${canonical(x)} ${lastGuide}`);
      }
    }
    return guides.join(" ");
  }
  const bottom = canonical(Math.min(bounds.bottom, bounds.top + (lastIndex + 1) * spacing));
  return `M ${canonical(bounds.left)} ${top} H ${canonical(bounds.right)} V ${bottom} H ${canonical(bounds.left)} Z`;
}

function canonical(value: number): string {
  return String(roundCanonical(value));
}

export function sameBackground(left: PageV1, right: PageV1): boolean {
  return (
    left.background.type === right.background.type &&
    (left.background.type === "none" ||
      (right.background.type !== "none" && left.background.spacing === right.background.spacing))
  );
}
