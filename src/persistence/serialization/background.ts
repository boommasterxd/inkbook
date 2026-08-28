import { backgroundGuideLayout } from "../../domain/geometry/public";
import type { BackgroundV1, PageV1 } from "../../domain/schema/public";
import { PAGE_MARGIN, PAGE_WIDTH } from "../../domain/schema/public";
import { serializeSvgNumber } from "../documents/svg-number";
import { DOCUMENT_PALETTE, DOCUMENT_THEME_FALLBACK } from "../documents/svg-theme";
import { serializePath } from "./path-markup";

const GUIDE_WIDTH = 1;
const DOT_WIDTH = 2;
const SUBPATHS_PER_GUIDE_PATH = 10_000;

export function backgroundFitsStaticLimit(
  background: BackgroundV1,
  lockedHeight: number,
  maximumBytes: number,
): boolean {
  const pageBytes = serializePage(lockedHeight).length;
  if (background.type === "none") return pageBytes <= maximumBytes;
  const commands = backgroundCommandStatistics(background, lockedHeight);
  const wrapperBytes = serializePath("", guideAttributes(background.type)).length;
  const pathCount = Math.ceil(commands.subpaths / SUBPATHS_PER_GUIDE_PATH);
  return pageBytes + commands.bytes + pathCount * wrapperBytes <= maximumBytes;
}

export function backgroundPathDataByteLength(
  background: BackgroundV1,
  lockedHeight: number,
): number {
  const pagePathBytes = rectanglePath(0, 0, PAGE_WIDTH, lockedHeight).length;
  return background.type === "none"
    ? pagePathBytes
    : pagePathBytes + backgroundCommandStatistics(background, lockedHeight).bytes;
}

export class BackgroundFragmentCache {
  #builds = 0;
  #key = "";
  #svg = "";

  public get builds(): number {
    return this.#builds;
  }

  public clear(): void {
    this.#key = "";
    this.#svg = "";
  }

  public resolve(page: PageV1, lockedHeight: number, maximumBytes: number): string | null {
    if (!backgroundFitsStaticLimit(page.background, lockedHeight, maximumBytes)) return null;
    const key = `${JSON.stringify(page.background)}:${lockedHeight}`;
    if (key !== this.#key) {
      this.#key = key;
      this.#svg = serializeBackgroundPaths(page.background, lockedHeight).join("");
      this.#builds += 1;
    }
    return this.#svg;
  }
}

export function serializeBackgroundPaths(background: BackgroundV1, lockedHeight: number): string[] {
  const page = serializePage(lockedHeight);
  if (background.type === "none") return [page];

  const guidePaths =
    background.type === "dots"
      ? dotPaths(background, lockedHeight)
      : gridPaths(background, lockedHeight);
  const attributes = guideAttributes(background.type);
  return [page, ...guidePaths.map((path) => serializePath(path, attributes))];
}

function serializePage(lockedHeight: number): string {
  return serializePath(rectanglePath(0, 0, PAGE_WIDTH, lockedHeight), {
    class: "inkbook-theme-page",
    fill: DOCUMENT_PALETTE.light.page,
  });
}

function guideAttributes(type: Exclude<BackgroundV1["type"], "none">) {
  return {
    class: "inkbook-theme-guide",
    fill: "none",
    stroke: DOCUMENT_THEME_FALLBACK.guide,
    "stroke-width": type === "dots" ? DOT_WIDTH : GUIDE_WIDTH,
    "stroke-linecap": type === "dots" ? "round" : "butt",
  } as const;
}

function backgroundCommandStatistics(
  background: Exclude<BackgroundV1, { type: "none" }>,
  lockedHeight: number,
): { readonly bytes: number; readonly subpaths: number } {
  const extent = guideExtent(background, lockedHeight);
  const xs = axisStatistics(extent.startX, extent.endX, extent.xStep, extent.xCount);
  const ys = axisStatistics(extent.startY, extent.endY, extent.yStep, extent.yCount);
  if (background.type === "dots") {
    return {
      bytes: ys.count * (4 * xs.count + 2 * xs.serializedBytes) + 2 * xs.count * ys.serializedBytes,
      subpaths: xs.count * ys.count,
    };
  }
  const fixedHorizontalBytes = number(extent.startX).length + number(extent.endX).length + 4;
  const horizontalBytes = ys.count * fixedHorizontalBytes + 2 * ys.serializedBytes;
  if (background.type === "lines") return { bytes: horizontalBytes, subpaths: ys.count };
  const fixedVerticalBytes = number(extent.coverageStartY).length + number(extent.endY).length + 4;
  return {
    bytes: horizontalBytes + xs.count * fixedVerticalBytes + 2 * xs.serializedBytes,
    subpaths: ys.count + xs.count,
  };
}

function axisStatistics(
  start: number,
  end: number,
  spacing: number,
  count: number,
): { readonly count: number; readonly serializedBytes: number } {
  let serializedBytes = 0;
  for (let index = 0; index < count; index += 1) {
    const value = axisPoint(start, end, spacing, index, count);
    serializedBytes += number(value).length;
  }
  return { count, serializedBytes };
}

function gridPaths(
  background: Extract<BackgroundV1, { type: "lines" | "squares" }>,
  lockedHeight: number,
): string[] {
  const paths = new GuidePathChunks();
  const { type } = background;
  const extent = guideExtent(background, lockedHeight);
  for (let index = 0; index < extent.yCount; index += 1) {
    const y = axisPoint(extent.startY, extent.endY, extent.yStep, index, extent.yCount);
    paths.push(lineSubpath(extent.startX, y, extent.endX, y));
  }
  if (type === "squares") {
    for (let index = 0; index < extent.xCount; index += 1) {
      const x = axisPoint(extent.startX, extent.endX, extent.xStep, index, extent.xCount);
      paths.push(lineSubpath(x, extent.coverageStartY, x, extent.endY));
    }
  }
  return paths.finish();
}

function dotPaths(
  background: Extract<BackgroundV1, { type: "dots" }>,
  lockedHeight: number,
): string[] {
  const paths = new GuidePathChunks();
  const extent = guideExtent(background, lockedHeight);
  for (let yIndex = 0; yIndex < extent.yCount; yIndex += 1) {
    const y = axisPoint(extent.startY, extent.endY, extent.yStep, yIndex, extent.yCount);
    for (let xIndex = 0; xIndex < extent.xCount; xIndex += 1) {
      const x = axisPoint(extent.startX, extent.endX, extent.xStep, xIndex, extent.xCount);
      paths.push(lineSubpath(x, y, x, y));
    }
  }
  return paths.finish();
}

function axisPoint(
  start: number,
  end: number,
  spacing: number,
  index: number,
  count: number,
): number {
  return index === count - 1 ? end : start + index * spacing;
}

interface GuideExtent {
  readonly coverageStartY: number;
  readonly endX: number;
  readonly endY: number;
  readonly startX: number;
  readonly startY: number;
  readonly xCount: number;
  readonly xStep: number;
  readonly yCount: number;
  readonly yStep: number;
}

function guideExtent(
  background: Exclude<BackgroundV1, { type: "none" }>,
  lockedHeight: number,
): GuideExtent {
  const layout = backgroundGuideLayout({
    background,
    innerWidth: PAGE_WIDTH - 2 * PAGE_MARGIN,
    margin: PAGE_MARGIN,
    pageHeight: lockedHeight,
  });
  return {
    coverageStartY: layout.top,
    endX: layout.right,
    endY: layout.bottom,
    startX: layout.left,
    startY: layout.top,
    xCount: layout.horizontalPointCount,
    xStep: layout.horizontalSpacing,
    yCount: layout.verticalPointCount,
    yStep: layout.verticalSpacing,
  };
}

class GuidePathChunks {
  private readonly completed: string[] = [];
  private current: string[] = [];

  public push(subpath: string): void {
    this.current.push(subpath);
    if (this.current.length === SUBPATHS_PER_GUIDE_PATH) this.flush();
  }

  public finish(): string[] {
    this.flush();
    return this.completed;
  }

  private flush(): void {
    if (this.current.length === 0) return;
    this.completed.push(this.current.join(""));
    this.current = [];
  }
}

function rectanglePath(x: number, y: number, width: number, height: number): string {
  return (
    `M${number(x)} ${number(y)}L${number(x + width)} ${number(y)}` +
    `L${number(x + width)} ${number(y + height)}L${number(x)} ${number(y + height)}Z`
  );
}

function lineSubpath(x1: number, y1: number, x2: number, y2: number): string {
  return `M${number(x1)} ${number(y1)}L${number(x2)} ${number(y2)}`;
}

function number(value: number): string {
  return serializeSvgNumber(value);
}
