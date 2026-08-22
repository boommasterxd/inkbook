import type { BackgroundV1, PageV1 } from "../../domain/schema/public";
import { roundCanonical } from "../../domain/geometry/primitives";

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
}

interface BackgroundCacheEntry extends BackgroundGeometryResult {
  readonly key: string;
}

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
    const maximumIndex = Math.max(0, Math.floor((writableBottom - request.margin) / spacing));
    const firstVisibleIndex = Math.min(
      maximumIndex,
      Math.max(0, Math.floor((request.visibleTop - viewportHeight - request.margin) / spacing)),
    );
    const lastVisibleIndex = Math.min(
      maximumIndex,
      Math.max(
        firstVisibleIndex,
        Math.ceil((request.visibleBottom + viewportHeight - request.margin) / spacing),
      ),
    );
    const key = [
      request.background.type,
      spacing,
      request.innerWidth,
      request.margin,
      writableBottom,
      firstVisibleIndex,
      lastVisibleIndex,
    ].join(":");
    if (this.#entry?.key === key) {
      this.#hits += 1;
      return { ...this.#entry, hit: true };
    }

    const d = buildBackgroundPath(
      spacing,
      request.margin,
      request.innerWidth,
      writableBottom,
      firstVisibleIndex,
      lastVisibleIndex,
    );
    this.#builds += 1;
    this.#entry = { d, firstVisibleIndex, hit: false, key, lastVisibleIndex };
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
    this.#entry = { d: "", firstVisibleIndex: 0, hit: false, key, lastVisibleIndex: 0 };
    return this.#entry;
  }
}

function buildBackgroundPath(
  spacing: number,
  margin: number,
  innerWidth: number,
  writableBottom: number,
  firstIndex: number,
  lastIndex: number,
): string {
  const left = margin;
  const right = margin + innerWidth;
  const top = canonical(margin + firstIndex * spacing);
  const bottom = canonical(Math.min(writableBottom, margin + (lastIndex + 1) * spacing));
  return `M ${canonical(left)} ${top} H ${canonical(right)} V ${bottom} H ${canonical(left)} Z`;
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
