import type { InkSnapshotV1 } from "../../../src/domain/schema/public";
import { serializeSvgEnvelope } from "../../../src/persistence/documents/svg-envelope";

export const MAXIMUM_PATH_BYTES = 8 * 1024 * 1024;

const snapshot: InkSnapshotV1 = {
  elements: [],
  format: "inkbook",
  page: {
    activeBufferLines: 3,
    background: { type: "none" },
    innerWidth: 2000,
    lockedBufferLines: 1,
    margin: 24.3,
  },
  revision: 3,
  version: 1,
};

export function createMaximumComplexityPath(): string {
  return `M 0 0${" L 1 1".repeat(199_999)}`.padEnd(MAXIMUM_PATH_BYTES, " ");
}

export function createMaximumComplexitySvg(): string {
  return serializeSvgEnvelope(snapshot, 148.6, {
    background: [],
    content: [`<path d="${createMaximumComplexityPath()}" fill="none" stroke="#112233FF"/>`],
    highlights: [],
  });
}
