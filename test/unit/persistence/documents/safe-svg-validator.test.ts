import { describe, expect, it } from "vitest";

import type { InkSnapshotV1 } from "../../../../src/domain/schema/public";
import {
  validateSafeSvg,
  validateSafeSvgSteps,
  validateNewerVersionSafeSvg,
} from "../../../../src/persistence/documents/safe-svg-validator";
import { serializeSvgEnvelope } from "../../../../src/persistence/documents/svg-envelope";
import { MAXIMUM_TOTAL_PATH_DATA_BYTES } from "../../../../src/persistence/documents/svg-output-limits";
import {
  CANONICAL_THEME_STYLESHEET,
  LEGACY_THEME_STYLESHEET_V1,
} from "../../../../src/persistence/documents/svg-theme";
import {
  createMaximumComplexityPath,
  MAXIMUM_PATH_BYTES,
} from "../../../fixtures/persistence/safe-svg";

const MAXIMUM_PATHS = 60_004;
const MAXIMUM_PATH_COMMANDS = 20_000;
const MAXIMUM_TOTAL_COMMANDS = 8_000_000;
const PLAIN_PATH = '<path d="M 0 0" fill="none"/>';

const snapshot: InkSnapshotV1 = {
  format: "inkbook",
  version: 1,
  revision: 3,
  page: {
    innerWidth: 2000,
    margin: 24.3,
    background: { type: "none" },
    writingLineHeight: 100,
    activeBufferLines: 3,
    lockedBufferLines: 1,
  },
  elements: [],
};

function validSvg(): string {
  return serializeSvgEnvelope(snapshot, 148.6, {
    background: [
      '<path class="inkbook-theme-page" d="M 0 0 L 2048.6 0 L 2048.6 148.6 L 0 148.6 Z" fill="#F6F6F6FF"/>',
      '<path class="inkbook-theme-guide" d="M 0 1 L 2 1" fill="none" stroke="#70707040"/>',
    ],
    highlights: [
      '<path class="inkbook-theme-stroke" d="M 1 2 L 2 3" fill="none" stroke="#222222FF"/>',
    ],
    content: [
      '<path class="inkbook-theme-fill" d="M 2 2 L 3 3" fill="#222222FF"/>',
      '<path class="inkbook-theme-stroke-fill" d="M 3 3 L 4 4" fill="#222222FF" stroke="#222222FF"/>',
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

function compactMaximumCommandPath(): string {
  const pathData = `M 0 0${" Z M 0 0".repeat(MAXIMUM_PATH_COMMANDS / 2 - 1)} Z`;
  return `<path d="${pathData}" fill="none"/>`;
}

function exhaustValidation(steps: ReturnType<typeof validateSafeSvgSteps>) {
  let yields = 0;
  let step = steps.next();
  while (!step.done) {
    yields += 1;
    step = steps.next();
  }
  return { result: step.value, yields };
}

function expectRejectedContentPaths(paths: readonly string[]): void {
  const svg = svgWithContentPaths(paths);
  const { result } = exhaustValidation(
    validateSafeSvgSteps(svg, { pathsPerStep: paths.length, totalInputBytes: svg.length }),
  );

  expect(result).toBeNull();
}

describe("strict safe SVG validation", () => {
  it("accepts the canonical envelope and returns bounded metadata", () => {
    expect(validateSafeSvg(validSvg())).toMatchObject({
      lockedHeight: 148.6,
      pathCommands: 15,
      paths: 6,
      revision: 3,
    });
  });

  it("accepts the previous exact dark page palette for version 1 input", () => {
    const legacySvg = validSvg().replace(CANONICAL_THEME_STYLESHEET, LEGACY_THEME_STYLESHEET_V1);

    expect(validateSafeSvg(legacySvg)).not.toBeNull();
  });

  it.each([
    (svg: string) => `<?xml version="1.0"?>${svg}`,
    (svg: string) => `<!DOCTYPE svg>${svg}`,
    (svg: string) =>
      svg.replace('<g id="inkbook-content">', '<script>bad()</script><g id="inkbook-content">'),
    (svg: string) => svg.replace('stroke-width="4"', 'onclick="bad()"'),
    (svg: string) => svg.replace('stroke="#112233FF"', 'stroke="url(https://invalid)"'),
    (svg: string) => svg.replace('fill="#F6F6F6FF"', 'fill="#212121FF"'),
    (svg: string) => svg.replace('stroke="#70707040"', 'stroke="#99999940"'),
    (svg: string) => svg.replace('stroke="#222222FF"', 'stroke="#DADADAFF"'),
    (svg: string) => svg.replace('fill="#222222FF"', 'fill="#DADADAFF"'),
    (svg: string) =>
      svg.replace(
        'class="inkbook-theme-stroke-fill" d="M 3 3 L 4 4" fill="#222222FF"',
        'class="inkbook-theme-stroke-fill" d="M 3 3 L 4 4" fill="#DADADAFF"',
      ),
    (svg: string) => svg.replace("M 1 1 L 2 2", "M 1e2 1 L 2 2"),
    (svg: string) => svg.replace('stroke-width="4"', 'stroke-width="4.000"'),
    (svg: string) =>
      svg.replace('stroke-width="4"', 'stroke-width="4" stroke-dasharray="0.0001 2"'),
    (svg: string) => svg.replace('stroke-width="4"', 'stroke-opacity="0.12345"'),
    (svg: string) => svg.replace(" viewBox=", ' width="url(https://invalid)" viewBox='),
    (svg: string) => svg.replace('<g id="inkbook-highlights">', ""),
  ])("rejects unsafe or noncanonical markup", (mutate) => {
    expect(validateSafeSvg(mutate(validSvg()))).toBeNull();
  });

  it("rejects an unknown path class without modifying the canonical stylesheet", () => {
    const unsafe = validSvg().replace(
      '<path class="inkbook-theme-page"',
      '<path class="unknown-class"',
    );

    expect(unsafe).toContain('<path class="unknown-class"');
    expect(validateSafeSvg(unsafe)).toBeNull();
  });
});

describe("safe SVG metadata and bounded validation", () => {
  it.each([
    "<script>bad()</script>",
    "<unknown />",
    "<![CDATA[bad]]>",
    "<!--bad-->",
    "<?inkbook bad?>",
  ])("rejects literal markup inside metadata: %s", (markup) => {
    const unsafe = validSvg().replace("</metadata>", `${markup}</metadata>`);

    expect(validateSafeSvg(unsafe)).toBeNull();
    expect(
      validateNewerVersionSafeSvg(
        unsafe.replace('data-inkbook-version="1"', 'data-inkbook-version="2"'),
      ),
    ).toBeNull();
  });

  it("accepts escaped markup characters as metadata text", () => {
    const escaped = validSvg().replace(
      '"elements":[]',
      '"elements":[],"text":"&lt;script&gt;&amp;&lt;/script&gt;"',
    );

    expect(validateSafeSvg(escaped)?.metadataText).toContain('"text":"<script>&</script>"');
  });

  it("validates and decodes large escaped metadata across bounded slices", () => {
    const largeText = `${"a".repeat(300_000)}&lt;x&gt;`;
    const svg = validSvg().replace('"elements":[]', `"elements":[],"text":"${largeText}"`);
    const { result, yields } = exhaustValidation(
      validateSafeSvgSteps(svg, { pathsPerStep: 60_004 }),
    );

    expect(yields).toBeGreaterThan(5);
    expect(result?.metadataText.length).toBeGreaterThan(300_000);
    expect(result?.metadataText.endsWith('<x>"}')).toBe(true);
  });

  it("admits allowlisted static markup from a newer version only for safe fallback preview", () => {
    const newer = validSvg().replace('data-inkbook-version="1"', 'data-inkbook-version="2"');

    expect(validateSafeSvg(newer)).toBeNull();
    expect(validateNewerVersionSafeSvg(newer)).toMatchObject({ version: 2 });
    expect(validateNewerVersionSafeSvg(validSvg())).toBeNull();
    expect(
      validateNewerVersionSafeSvg(newer.replace("<path ", '<path onclick="bad()" ')),
    ).toBeNull();
  });

  it("slices within one maximum-complexity path independently of the path batch size", () => {
    const svg = validSvg().replace("M 1 1 L 2 2", createMaximumComplexityPath());
    const { result, yields } = exhaustValidation(
      validateSafeSvgSteps(svg, { pathsPerStep: 60_004 }),
    );

    expect(yields).toBeGreaterThan(70);
    expect(result).toMatchObject({ pathCommands: 20_013, paths: 6, revision: 3 });
  });

  it("rejects an aggregate path count above 60,004", () => {
    const svg = svgWithContentPaths(Array(MAXIMUM_PATHS + 1).fill(PLAIN_PATH));
    const { result } = exhaustValidation(
      validateSafeSvgSteps(svg, {
        pathsPerStep: MAXIMUM_PATHS + 1,
        totalInputBytes: svg.length,
      }),
    );

    expect(result).toBeNull();
  });

  it("rejects an aggregate command count above 8,000,000", () => {
    const maximumCommandPath = compactMaximumCommandPath();
    const paths = Array(MAXIMUM_TOTAL_COMMANDS / MAXIMUM_PATH_COMMANDS).fill(maximumCommandPath);
    paths.push(PLAIN_PATH);

    expectRejectedContentPaths(paths);
  }, 15_000);

  it("rejects aggregate path data above 48 MiB", () => {
    const maximumPathData = "M 0 0".padEnd(MAXIMUM_PATH_BYTES, " ");
    const maximumPath = `<path d="${maximumPathData}" fill="none"/>`;
    const paths = Array(MAXIMUM_TOTAL_PATH_DATA_BYTES / MAXIMUM_PATH_BYTES).fill(maximumPath);
    paths.push(PLAIN_PATH);

    expectRejectedContentPaths(paths);
  }, 15_000);
});
