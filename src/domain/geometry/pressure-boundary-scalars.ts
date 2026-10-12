import type { PressureBoundaryArc, PressureBoundaryLine } from "./pressure-joins";

type Boundary = PressureBoundaryLine | PressureBoundaryArc;

export interface PressureBoundaryScalars {
  readonly endpointScale: number;
  readonly absoluteSweep?: number;
  readonly sweepSign?: number;
}

export const MAX_PRESSURE_BOUNDARY_SCALAR_ENTRIES = 256;

/** One union window owns these exact scalars for its unchanged source boundaries. */
export class PressureBoundaryScalarCache {
  readonly #entries = new Map<Boundary, PressureBoundaryScalars>();

  public constructor(private readonly capacity: number) {
    if (
      !Number.isInteger(capacity) ||
      capacity < 0 ||
      capacity > MAX_PRESSURE_BOUNDARY_SCALAR_ENTRIES
    )
      throw new RangeError("Invalid pressure boundary scalar capacity");
  }

  public read(boundary: Boundary): PressureBoundaryScalars | undefined {
    const cached = this.#entries.get(boundary);
    if (cached !== undefined) return cached;
    if (this.#entries.size >= this.capacity) return undefined;
    const endpointScale = Math.max(
      1,
      Math.abs(boundary.start.x),
      Math.abs(boundary.start.y),
      Math.abs(boundary.end.x),
      Math.abs(boundary.end.y),
    );
    const sweep = boundary.kind === "arc" ? boundary.sweep : undefined;
    const scalars =
      sweep === undefined
        ? { endpointScale }
        : { endpointScale, absoluteSweep: Math.abs(sweep), sweepSign: Math.sign(sweep) };
    this.#entries.set(boundary, scalars);
    return scalars;
  }

  public clear(): void {
    this.#entries.clear();
  }
}
