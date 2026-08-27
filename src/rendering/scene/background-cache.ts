import { backgroundGuideLayout, roundCanonical } from "../../domain/geometry/public";
import type { BackgroundV1 } from "../../domain/schema/public";

export interface BackgroundGeometryRequest {
  readonly background: BackgroundV1;
  readonly innerWidth: number;
  readonly margin: number;
  readonly pageHeight: number;
}

export interface BackgroundPatternBounds {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

export interface BackgroundGeometryResult {
  readonly d: string;
  readonly edgeD: string;
  readonly hit: boolean;
  readonly paint: "none" | "pattern";
  readonly patternBounds: BackgroundPatternBounds | null;
  readonly patternX: number;
  readonly patternY: number;
}

interface BackgroundCacheEntry extends BackgroundGeometryResult {
  readonly key: string;
}

/**
 * Caches the single canonical background coverage rectangle. Pattern tiles own
 * repetition, so geometry never depends on viewport culling or guide counts.
 */
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
    const layout = backgroundGuideLayout({
      background: request.background,
      innerWidth: request.innerWidth,
      margin: request.margin,
      pageHeight: request.pageHeight,
    });
    const key = [
      request.background.type,
      request.background.spacing,
      request.innerWidth,
      request.margin,
      request.pageHeight,
      layout.left,
      layout.right,
      layout.top,
      layout.bottom,
    ].join(":");
    if (this.#entry?.key === key) {
      this.#hits += 1;
      return { ...this.#entry, hit: true };
    }
    const hasGuides =
      request.background.type === "lines"
        ? layout.verticalPointCount > 0
        : layout.horizontalPointCount > 0 && layout.verticalPointCount > 0;
    const patternBounds =
      hasGuides && layout.right > layout.left && layout.bottom > layout.top
        ? {
            bottom: layout.bottom,
            left: layout.left,
            right: layout.right,
            top: layout.top,
          }
        : null;
    this.#builds += 1;
    this.#entry = {
      d: patternBounds === null ? "" : patternCoveragePath(patternBounds),
      edgeD: patternBounds === null ? "" : terminalEdgePath(request.background, layout),
      hit: false,
      key,
      paint: "pattern",
      patternBounds,
      patternX: layout.left,
      patternY: layout.top,
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
    const key = `none:${String(request.innerWidth)}:${String(request.margin)}:${String(request.pageHeight)}`;
    if (this.#entry?.key === key) {
      this.#hits += 1;
      return { ...this.#entry, hit: true };
    }
    this.#builds += 1;
    this.#entry = {
      d: "",
      edgeD: "",
      hit: false,
      key,
      paint: "none",
      patternBounds: null,
      patternX: request.margin,
      patternY: request.margin,
    };
    return this.#entry;
  }
}

function terminalEdgePath(
  background: Exclude<BackgroundV1, { type: "none" }>,
  layout: ReturnType<typeof backgroundGuideLayout>,
): string {
  const terminalX = hasTerminalGuide(layout.horizontal, layout.horizontalSpacing);
  const terminalY = hasTerminalGuide(layout.vertical, layout.verticalSpacing);
  if (background.type === "lines") {
    return terminalY
      ? `M ${canonical(layout.left)} ${canonical(layout.bottom)} H ${canonical(layout.right)}`
      : "";
  }
  if (background.type === "squares") {
    const parts: string[] = [];
    if (terminalX) {
      parts.push(
        `M ${canonical(layout.right)} ${canonical(layout.top)} V ${canonical(layout.bottom)}`,
      );
    }
    if (terminalY) {
      parts.push(
        `M ${canonical(layout.left)} ${canonical(layout.bottom)} H ${canonical(layout.right)}`,
      );
    }
    return parts.join(" ");
  }
  return terminalDotPath(layout, terminalX, terminalY);
}

function terminalDotPath(
  layout: ReturnType<typeof backgroundGuideLayout>,
  terminalX: boolean,
  terminalY: boolean,
): string {
  const parts: string[] = [];
  if (terminalX) {
    const periodicBottom = periodicEnd(layout.vertical, layout.verticalSpacing);
    parts.push(
      `M ${canonical(layout.right)} ${canonical(layout.top)} V ${canonical(periodicBottom)}`,
    );
    if (terminalY) parts.push(pointSubpath(layout.right, layout.bottom));
  }
  if (terminalY) {
    const periodicRight = periodicEnd(layout.horizontal, layout.horizontalSpacing);
    parts.push(
      `M ${canonical(layout.left)} ${canonical(layout.bottom)} H ${canonical(periodicRight)}`,
    );
  }
  return parts.join(" ");
}

function hasTerminalGuide(
  axis: { end: number; intervalCount: number; start: number },
  spacing: number,
) {
  return roundCanonical(axis.start + axis.intervalCount * spacing) !== axis.end;
}

function periodicEnd(axis: { intervalCount: number; start: number }, spacing: number): number {
  return roundCanonical(axis.start + axis.intervalCount * spacing);
}

function pointSubpath(x: number, y: number): string {
  return `M ${canonical(x)} ${canonical(y)} L ${canonical(x)} ${canonical(y)}`;
}

export function patternCoveragePath(bounds: BackgroundPatternBounds, inset = 0): string {
  return (
    `M ${canonical(bounds.left - inset)} ${canonical(bounds.top - inset)} ` +
    `H ${canonical(bounds.right + inset)} V ${canonical(bounds.bottom + inset)} ` +
    `H ${canonical(bounds.left - inset)} Z`
  );
}

function canonical(value: number): string {
  return String(roundCanonical(value));
}
