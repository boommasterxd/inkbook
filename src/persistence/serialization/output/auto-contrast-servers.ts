import { sharedAutoContrastBox } from "../../../domain/images/auto-contrast";
import { FILE_SCHEMA_LIMITS } from "../../../domain/schema/public";
import { sha256Hex } from "../sha256";
import { autoContrastFilterMarkup } from "./auto-contrast-definitions";
import { autoTileAttributes, autoTileViewBox, type AutoPaintTile } from "./auto-contrast-tiles";
import { ChunkedOutputLimitError } from "./chunked-output-assembler";
import { usesAutoImagePresentation } from "./auto-contrast-definitions";
import type { ImageElementV3, InkSnapshotV1 } from "../../../domain/schema/public";

export function* autoPaintDefinitionsFragments(
  snapshot: InkSnapshotV1 | undefined,
  registry?: AutoPaintServerRegistry,
  images?: readonly ImageElementV3[],
): Iterable<string> {
  if (!usesAutoImagePresentation(snapshot, images)) return;
  yield* (registry ?? new AutoPaintServerRegistry()).fragments();
}

export interface AutoPaintServer {
  readonly key: string;
  readonly box: Readonly<AutoPaintTile>;
}

/** The server key excludes element transforms and mutable image/page presentation. */
export function autoPaintServer(tile: AutoPaintTile): AutoPaintServer {
  const bounds = sharedAutoContrastBox({
    minX: tile.x,
    minY: tile.y,
    maxX: tile.x + tile.width,
    maxY: tile.y + tile.height,
  });
  const box = Object.freeze({
    x: bounds.minX,
    y: bounds.minY,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
  });
  return Object.freeze({ key: sha256Hex(autoTileViewBox(box)), box });
}

/** One bounded document registry owns the only underlay-use subtree for each world box. */
export class AutoPaintServerRegistry {
  readonly #entries = new Map<string, { server: AutoPaintServer; markup: string }>();
  #contentByteLength = 0;

  public get contentByteLength(): number {
    return this.#contentByteLength;
  }

  public get servers(): Iterable<AutoPaintServer> {
    return this.#values();
  }

  public add(server: AutoPaintServer): void {
    if (this.#entries.has(server.key)) return;
    const markup = serverMarkup(server);
    if (this.#contentByteLength + markup.length > FILE_SCHEMA_LIMITS.totalInputBytes)
      throw new ChunkedOutputLimitError();
    this.#entries.set(server.key, { server, markup });
    this.#contentByteLength += markup.length;
  }

  public *fragments(): Iterable<string> {
    yield '<defs id="inkbook-auto-paints">';
    for (const entry of this.#entries.values()) yield entry.markup;
    yield "</defs>";
  }

  *#values(): Iterable<AutoPaintServer> {
    for (const entry of this.#entries.values()) yield entry.server;
  }
}

function serverMarkup(server: AutoPaintServer): string {
  const attributes = autoTileAttributes(server.box);
  const filter = `inkbook-auto-server-filter-${server.key}`;
  return (
    autoContrastFilterMarkup(filter, attributes) +
    `<pattern id="inkbook-auto-server-paint-${server.key}" ${attributes} viewBox="${autoTileViewBox(server.box)}" patternUnits="userSpaceOnUse" patternContentUnits="userSpaceOnUse"><use href="#inkbook-auto-underlay" filter="url(#${filter})"/></pattern>`
  );
}
