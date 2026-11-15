import type { Bounds } from "../../../domain/geometry/primitives";
import { serializeSvgNumber as number } from "../../documents/svg-number";
import { AUTO_CONTRAST_TILE_AXIS } from "../../../domain/images/auto-contrast";

const MAXIMUM_TILES_PER_ATOM = 2048;

export interface AutoPaintTile {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Vector clipping keeps large strokes continuous without a page-sized filter raster. */
export function* autoPaintTiles(bounds: Bounds): Iterable<AutoPaintTile> {
  const left = Math.max(0, Math.floor(bounds.minX * 1000) / 1000);
  const top = Math.max(0, Math.floor(bounds.minY * 1000) / 1000);
  const right = Math.min(2048.6, Math.ceil(bounds.maxX * 1000) / 1000);
  const bottom = Math.min(1_000_000, Math.ceil(bounds.maxY * 1000) / 1000);
  if (right <= left || bottom <= top) return;
  const columns = Math.ceil((right - left) / AUTO_CONTRAST_TILE_AXIS);
  const rows = Math.ceil((bottom - top) / AUTO_CONTRAST_TILE_AXIS);
  if (columns * rows > MAXIMUM_TILES_PER_ATOM)
    throw new RangeError("Auto contrast geometry exceeds the tile capacity.");
  for (let row = 0; row < rows; row += 1) {
    const y = top + row * AUTO_CONTRAST_TILE_AXIS;
    for (let column = 0; column < columns; column += 1) {
      const x = left + column * AUTO_CONTRAST_TILE_AXIS;
      yield {
        x,
        y,
        width: Math.min(AUTO_CONTRAST_TILE_AXIS, right - x),
        height: Math.min(AUTO_CONTRAST_TILE_AXIS, bottom - y),
      };
    }
  }
}

export function autoTileAttributes(tile: AutoPaintTile): string {
  return `x="${number(tile.x)}" y="${number(tile.y)}" width="${number(tile.width)}" height="${number(tile.height)}"`;
}

export function autoTileViewBox(tile: AutoPaintTile): string {
  return [tile.x, tile.y, tile.width, tile.height].map(number).join(" ");
}
