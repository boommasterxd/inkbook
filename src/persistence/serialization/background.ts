import { centeredGuideAxis } from "../../domain/geometry/public";
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
      ? dotPaths(background.spacing, lockedHeight)
      : gridPaths(background.type, background.spacing, lockedHeight);
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
  const extent = guideExtent(background.type, background.spacing, lockedHeight);
  const xs = axisStatistics(extent.startX, extent.endX, background.spacing);
  const ys = axisStatistics(extent.startY, extent.endY, background.spacing);
  if (background.type === "dots") {
    return {
      bytes: ys.count * (4 * xs.count + 2 * xs.serializedBytes) + 2 * xs.count * ys.serializedBytes,
      subpaths: xs.count * ys.count,
    };
  }
  const fixedHorizontalBytes = number(extent.startX).length + number(extent.endX).length + 4;
  const horizontalBytes = ys.count * fixedHorizontalBytes + 2 * ys.serializedBytes;
  if (background.type === "lines") return { bytes: horizontalBytes, subpaths: ys.count };
  const fixedVerticalBytes = number(extent.startY).length + number(extent.endY).length + 4;
  return {
    bytes: horizontalBytes + xs.count * fixedVerticalBytes + 2 * xs.serializedBytes,
    subpaths: ys.count + xs.count,
  };
}

function axisStatistics(
  start: number,
  end: number,
  spacing: number,
): { readonly count: number; readonly serializedBytes: number } {
  let count = 0;
  let serializedBytes = 0;
  for (let value = start; value <= end; value += spacing) {
    count += 1;
    serializedBytes += number(value).length;
  }
  return { count, serializedBytes };
}

function gridPaths(type: "lines" | "squares", spacing: number, lockedHeight: number): string[] {
  const paths = new GuidePathChunks();
  const extent = guideExtent(type, spacing, lockedHeight);
  for (let y = extent.startY; y <= extent.endY; y += spacing) {
    paths.push(lineSubpath(extent.startX, y, extent.endX, y));
  }
  if (type === "squares") {
    for (let x = extent.startX; x <= extent.endX; x += spacing) {
      paths.push(lineSubpath(x, extent.startY, x, extent.endY));
    }
  }
  return paths.finish();
}

function dotPaths(spacing: number, lockedHeight: number): string[] {
  const paths = new GuidePathChunks();
  const extent = guideExtent("dots", spacing, lockedHeight);
  for (let y = extent.startY; y <= extent.endY; y += spacing) {
    for (let x = extent.startX; x <= extent.endX; x += spacing) {
      paths.push(lineSubpath(x, y, x, y));
    }
  }
  return paths.finish();
}

interface GuideExtent {
  readonly endX: number;
  readonly endY: number;
  readonly startX: number;
  readonly startY: number;
}

function guideExtent(
  type: Exclude<BackgroundV1["type"], "none">,
  spacing: number,
  lockedHeight: number,
): GuideExtent {
  const vertical = centeredGuideAxis(
    PAGE_MARGIN,
    Math.max(0, lockedHeight - 2 * PAGE_MARGIN),
    spacing,
  );
  if (type === "lines") {
    return {
      endX: PAGE_WIDTH - PAGE_MARGIN,
      endY: vertical.end,
      startX: PAGE_MARGIN,
      startY: vertical.start,
    };
  }
  const horizontal = centeredGuideAxis(PAGE_MARGIN, PAGE_WIDTH - 2 * PAGE_MARGIN, spacing);
  return {
    endX: horizontal.end,
    endY: vertical.end,
    startX: horizontal.start,
    startY: vertical.start,
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
