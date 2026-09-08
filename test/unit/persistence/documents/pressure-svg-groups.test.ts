import { describe, expect, it } from "vitest";
import {
  validateSafeSvg,
  validateSafeSvgSteps,
} from "../../../../src/persistence/documents/safe-svg-validator";
import { serializeSvgEnvelope } from "../../../../src/persistence/documents/svg-envelope";
import { createSnapshot } from "../serialization/fixtures";

const PATH = '<path d="M0 0L1 1" fill="none" stroke="#123456FF" stroke-width="4"/>';
const GROUP = `<g opacity="0.5">${PATH}</g>`;

function envelope(content: string, highlights = "", background = ""): string {
  return serializeSvgEnvelope(createSnapshot([]), 148.6, {
    content: [content],
    highlights: [highlights],
    background: [background],
  });
}

function complete(svg: string) {
  const iterator = validateSafeSvgSteps(svg);
  let step = iterator.next();
  while (!step.done) step = iterator.next();
  return step.value;
}

describe("bounded pressure opacity groups", () => {
  it("allows groups in both paint bands and retains exact group ranges", () => {
    const svg = envelope(GROUP + PATH, GROUP);
    const result = validateSafeSvg(svg);
    expect(result?.paths).toBe(3);
    expect(svg.slice(result!.groups.content.start, result!.groups.content.end)).toBe(GROUP + PATH);
  });

  it.each([
    ["nested", `<g opacity="1">${GROUP}</g>`],
    ["empty", '<g opacity="1"></g>'],
    ["self closing", '<g opacity="1"/>'],
    ["missing opacity", `<g>${PATH}</g>`],
    ["unknown attribute", `<g opacity="1" transform="scale(2)">${PATH}</g>`],
    ["duplicate opacity", `<g opacity="1" opacity="0.5">${PATH}</g>`],
    ["invalid opacity", `<g opacity="1.1">${PATH}</g>`],
    ["noncanonical opacity", `<g opacity="0.50000">${PATH}</g>`],
    ["unknown child", '<g opacity="1"><circle/></g>'],
    ["too many parts", `<g opacity="1">${PATH.repeat(2)}</g>`],
    ["unclosed", `<g opacity="1">${PATH}`],
  ])("rejects %s groups", (_label, content) => {
    expect(validateSafeSvg(envelope(content))).toBeNull();
  });

  it("rejects pressure groups in the background", () => {
    expect(validateSafeSvg(envelope("", "", GROUP))).toBeNull();
  });

  it("accepts twenty thousand single-path groups within aggregate limits", () => {
    expect(complete(envelope(`<g opacity="1">${PATH}</g>`.repeat(20_000)))?.paths).toBe(20_000);
  });

  it("counts groups across both paint bands", () => {
    expect(complete(envelope(GROUP.repeat(10_001), GROUP.repeat(10_000)))).toBeNull();
  });

  it("yields while inspecting pressure parts", () => {
    const iterator = validateSafeSvgSteps(envelope(`<g opacity="1">${PATH}</g>`), {
      pathsPerStep: 1,
    });
    let yields = 0;
    let step = iterator.next();
    while (!step.done) {
      yields += 1;
      step = iterator.next();
    }
    expect(step.value?.paths).toBe(1);
    expect(yields).toBeGreaterThanOrEqual(1);
  });
});
