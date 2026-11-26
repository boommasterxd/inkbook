import { beforeAll, describe, expect, it } from "vitest";

import type { InkSnapshotV1 } from "../../../../src/domain/schema/public";
import {
  validateSafeSvg,
  validateSafeSvgSteps,
} from "../../../../src/persistence/documents/safe-svg-validator";
import { serializeSvgEnvelope } from "../../../../src/persistence/documents/svg-envelope";
import { MAXIMUM_TOTAL_PATH_DATA_BYTES } from "../../../../src/persistence/documents/svg-output-limits";
import { exhaustValidation, MAXIMUM_PATH_BYTES } from "../../../fixtures/persistence/safe-svg";

const PLAIN_PATH = '<path d="M 0 0" fill="none"/>';

const snapshot: InkSnapshotV1 = {
  format: "inkbook",
  version: 1,
  revision: 3,
  page: {
    innerWidth: 2000,
    margin: 24.3,
    background: { type: "none" },
    activeBufferLines: 3,
    lockedBufferLines: 1,
  },
  elements: [],
};

let validSvg: string;

beforeAll(() => {
  validSvg = createValidSvg();
});

function createValidSvg(): string {
  return serializeSvgEnvelope(snapshot, 148.6, {
    background: [
      '<path class="inkbook-theme-page" d="M 0 0 L 2048.6 0 L 2048.6 148.6 L 0 148.6 Z" fill="#F6F6F6FF"/>',
      '<path class="inkbook-theme-guide" d="M 0 1 L 2 1" fill="none" stroke="#70707040"/>',
    ],
    highlights: ['<path d="M 1 2 L 2 3" fill="none" stroke="#000000FF"/>'],
    content: [
      '<path d="M 2 2 L 3 3" fill="#000000FF"/>',
      '<path d="M 3 3 L 4 4" fill="#000000FF" stroke="#000000FF"/>',
      '<path d="M 1 1 L 2 2" fill="none" stroke="#112233FF" stroke-width="4"/>',
    ],
  });
}

function svgWithContentPaths(paths: readonly string[]): string {
  return serializeSvgEnvelope(snapshot, 148.6, {
    background: [],
    highlights: [],
    content: paths,
  });
}

const validateNewerVersionSafeSvg = (svg: string) =>
  exhaustValidation(validateSafeSvgSteps(svg, { versionPolicy: "newer" })).result;

function expectRejectedContentPaths(paths: readonly string[]): void {
  const svg = svgWithContentPaths(paths);
  const { result } = exhaustValidation(
    validateSafeSvgSteps(svg, { pathsPerStep: paths.length, totalInputBytes: svg.length }),
  );

  expect(result).toBeNull();
}

describe("strict safe SVG validation", () => {
  it.each([
    (svg: string) => `<?xml version="1.0"?>${svg}`,
    (svg: string) => `<!DOCTYPE svg>${svg}`,
    (svg: string) =>
      svg.replace('<g id="inkbook-content">', '<script>bad()</script><g id="inkbook-content">'),
    (svg: string) => svg.replace('stroke-width="4"', 'onclick="bad()"'),
    (svg: string) => svg.replace('stroke="#112233FF"', 'stroke="url(https://invalid)"'),
    (svg: string) => svg.replace('fill="#F6F6F6FF"', 'fill="#212121FF"'),
    (svg: string) => svg.replace('stroke="#70707040"', 'stroke="#99999940"'),
    (svg: string) => svg.replace('stroke="#000000FF"', 'stroke="red"'),
    (svg: string) => svg.replace('fill="#000000FF"', 'fill="inherit"'),
    (svg: string) =>
      svg.replace(
        ' d="M 3 3 L 4 4" fill="#000000FF"',
        ' class="unsupported" d="M 3 3 L 4 4" fill="#000000FF"',
      ),
    (svg: string) => svg.replace("M 1 1 L 2 2", "M 1e2 1 L 2 2"),
    (svg: string) => svg.replace('stroke-width="4"', 'stroke-width="4.000"'),
    (svg: string) =>
      svg.replace('stroke-width="4"', 'stroke-width="4" stroke-dasharray="0.0001 2"'),
    (svg: string) => svg.replace('stroke-width="4"', 'stroke-opacity="0.12345"'),
    (svg: string) => svg.replace(" viewBox=", ' width="url(https://invalid)" viewBox='),
    (svg: string) => svg.replace('<g id="inkbook-highlights">', ""),
  ])("rejects unsafe or noncanonical markup", (mutate) => {
    expect(validateSafeSvg(mutate(validSvg))).toBeNull();
  });
});

describe("safe SVG metadata and bounded validation", () => {
  it("admits allowlisted static markup from a newer version only for safe fallback preview", () => {
    const newer = validSvg.replace('data-inkbook-version="1"', 'data-inkbook-version="6"');

    expect(validateSafeSvg(newer)).toBeNull();
    expect(validateNewerVersionSafeSvg(newer)).toMatchObject({ version: 6 });
    expect(validateNewerVersionSafeSvg(validSvg)).toBeNull();
    expect(
      validateNewerVersionSafeSvg(newer.replace("<path ", '<path onclick="bad()" ')),
    ).toBeNull();
  });

  it("rejects aggregate path data above 48 MiB", () => {
    const maximumPathData = "M 0 0".padEnd(MAXIMUM_PATH_BYTES, " ");
    const maximumPath = `<path d="${maximumPathData}" fill="none"/>`;
    const paths = Array(MAXIMUM_TOTAL_PATH_DATA_BYTES / MAXIMUM_PATH_BYTES).fill(maximumPath);
    paths.push(PLAIN_PATH);

    expectRejectedContentPaths(paths);
  }, 15_000);
});
