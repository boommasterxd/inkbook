import { buildPressureCapsule } from "../../../src/domain/geometry/pressure-joins";

/** Capacity pressure transitions force the exact union's lossless fallback. */
export function createAdversarialPressureWindow() {
  return Array.from({ length: 64 }, (_, index) =>
    buildPressureCapsule(
      { x: index % 2 ? 0 : 200, y: index * 0.1, pressure: index % 2 },
      { x: index % 2 ? 200 : 0, y: (index + 1) * 0.1, pressure: (index + 1) % 2 },
      22,
    ),
  );
}
