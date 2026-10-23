import { VersionedCache } from "../../cache/versioned-cache";
import { isStoredStroke } from "../../elements/stroke-replacement-proof";
import { strokeLocalGeometry } from "../../geometry/stroke-position";
import type { SvgPathPart } from "../../geometry/svg-path-part";
import type { StrokeElementV1 } from "../../schema/public";
import type { ElementRecord } from "../types";

interface LocalShapeWitness {
  readonly samples: WeakRef<object>;
  readonly rotation: number;
  readonly pivotX: number;
  readonly pivotY: number;
  readonly width: number;
  readonly smoothing: number;
  readonly tool: StrokeElementV1["tool"];
}

interface PreparedPressurePath {
  readonly parts: readonly SvgPathPart[];
  readonly bytes: number;
  readonly local?: LocalShapeWitness;
}

// Local entries use shape provenance, rather than a positioned geometry version.
const LOCAL_PATH_VERSION = -1;
const LOCAL_SHAPE_WITNESS_BYTES = 192;

/** Internally generated local pressure paths, bounded independently of selection windows. */
export class PreparedPressurePathCache extends VersionedCache<PreparedPressurePath> {
  readonly #versions: Map<string, number>;
  public constructor(
    private readonly maximumBytes = 4 * 1024 * 1024,
    maximumEntries = 1024,
  ) {
    const versions = new Map<string, number>();
    super(maximumEntries, maximumBytes, (id) => versions.delete(id));
    this.#versions = versions;
  }

  public cachedVersions(): IterableIterator<readonly [string, number]> {
    return this.#versions.entries();
  }

  public *versionsFor(ids: ReadonlySet<string>): IterableIterator<readonly [string, number]> {
    if (ids.size < this.#versions.size) {
      for (const id of ids) {
        const version = this.#versions.get(id);
        if (version !== undefined) yield [id, version];
      }
    } else {
      for (const [id, version] of this.#versions) {
        if (ids.has(id)) yield [id, version];
      }
    }
  }

  public read(id: string, version: number): readonly SvgPathPart[] | undefined {
    if (this.#versions.get(id) === LOCAL_PATH_VERSION || version === LOCAL_PATH_VERSION) return;
    return this.getCached(id, version)?.parts;
  }

  public publish(id: string, version: number, parts: readonly SvgPathPart[]): void {
    this.#publish(id, version, parts);
  }

  public readLocal(id: string, stroke: StrokeElementV1): readonly SvgPathPart[] | undefined {
    if (!isStoredStroke(stroke) || !stroke.style.pressureEnabled) return;
    if (this.#versions.get(id) !== LOCAL_PATH_VERSION) return;
    const cached = this.getCached(id, LOCAL_PATH_VERSION);
    const witness = cached?.local;
    if (witness?.samples.deref() !== stroke.points || !matchesLocalShape(witness, stroke)) return;
    return cached?.parts;
  }

  /** The Store's confirmed geometry-neutral records already prove exact sample equality. */
  public retainGeometryNeutral(id: string, before: ElementRecord, after: ElementRecord): void {
    if (
      before.geometryVersion !== after.geometryVersion ||
      before.element.kind !== "stroke" ||
      after.element.kind !== "stroke" ||
      !isStoredStroke(after.element) ||
      !after.element.style.pressureEnabled
    )
      return;
    const original = before.element as StrokeElementV1;
    const replacement = after.element as StrokeElementV1;
    if (original.points === replacement.points || this.readLocal(id, original) === undefined)
      return;
    const cached = this.getCached(id, LOCAL_PATH_VERSION)!;
    if (!matchesLocalShape(cached.local!, replacement)) return;
    this.retainCached(
      id,
      LOCAL_PATH_VERSION,
      Object.freeze({
        parts: cached.parts,
        bytes: cached.bytes,
        local: Object.freeze({ ...cached.local!, samples: new WeakRef(replacement.points) }),
      }),
      cached.bytes,
    );
    this.#versions.set(id, LOCAL_PATH_VERSION);
  }

  public publishLocal(id: string, stroke: StrokeElementV1, parts: readonly SvgPathPart[]): void {
    if (!isStoredStroke(stroke) || !stroke.style.pressureEnabled) return;
    if (this.readLocal(id, stroke) !== undefined) return;
    const local = strokeLocalGeometry(stroke);
    this.#publish(id, LOCAL_PATH_VERSION, parts, {
      samples: new WeakRef(stroke.points),
      rotation: local.rotation,
      pivotX: local.pivot.x,
      pivotY: local.pivot.y,
      width: local.style.width,
      smoothing: local.style.smoothing,
      tool: local.tool,
    });
  }

  public invalidateWorld(id: string): void {
    if (this.#versions.get(id) !== LOCAL_PATH_VERSION) this.invalidate(id);
  }

  #publish(
    id: string,
    version: number,
    parts: readonly SvgPathPart[],
    local?: LocalShapeWitness,
  ): void {
    if (!this.retentionEnabled || parts.length !== 1 || parts[0]!.paint !== "fill") return;
    const bytes =
      128 +
      id.length * 2 +
      parts[0]!.d.length * 2 +
      (local === undefined ? 0 : LOCAL_SHAPE_WITNESS_BYTES);
    if (bytes > this.maximumBytes) return;
    this.retainCached(
      id,
      version,
      Object.freeze({
        parts: Object.freeze(parts.map((part) => Object.freeze({ ...part }))),
        bytes,
        ...(local === undefined ? {} : { local: Object.freeze(local) }),
      }),
      bytes,
    );
    this.#versions.set(id, version);
  }
}

function matchesLocalShape(witness: LocalShapeWitness, stroke: StrokeElementV1): boolean {
  const local = strokeLocalGeometry(stroke);
  return (
    witness.rotation === local.rotation &&
    witness.pivotX === local.pivot.x &&
    witness.pivotY === local.pivot.y &&
    witness.width === local.style.width &&
    witness.smoothing === local.style.smoothing &&
    witness.tool === local.tool
  );
}
