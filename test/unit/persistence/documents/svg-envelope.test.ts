import { describe, expect, it } from "vitest";

import { PORTABLE_PALETTE_V1, type InkSnapshotV1 } from "../../../../src/domain/schema/public";
import { serializeSvgEnvelope } from "../../../../src/persistence/documents/svg-envelope";
import {
  parseCanonicalSvgDecimal,
  parseCanonicalSvgOpacity,
  serializeSvgNumber,
  serializeSvgOpacity,
} from "../../../../src/persistence/documents/svg-number";
import {
  CANONICAL_THEME_STYLESHEET,
  DOCUMENT_PALETTE,
} from "../../../../src/persistence/documents/svg-theme";
import { escapeXmlText } from "../../../../src/persistence/documents/xml-text";

const snapshot: InkSnapshotV1 = {
  format: "inkbook",
  version: 1,
  revision: 7,
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

describe("SVG primitives", () => {
  it("serializes canonical bounded numbers", () => {
    expect(serializeSvgNumber(1.23456)).toBe("1.235");
    expect(serializeSvgNumber(-0)).toBe("0");
    expect(() => serializeSvgNumber(Number.POSITIVE_INFINITY)).toThrow("invalid-svg-number");
    expect(parseCanonicalSvgDecimal("1.234", 2)).toBe(1.234);
    expect(parseCanonicalSvgDecimal("1.230", 2)).toBeNull();
    expect(parseCanonicalSvgDecimal("1.2345", 2)).toBeNull();
    expect(parseCanonicalSvgOpacity("0")).toBe(0);
    expect(parseCanonicalSvgOpacity("0.0001")).toBe(0.0001);
    expect(parseCanonicalSvgOpacity("0.1234")).toBe(0.1234);
    expect(parseCanonicalSvgOpacity("1")).toBe(1);
    expect(parseCanonicalSvgOpacity("0.12345")).toBeNull();
    expect(parseCanonicalSvgOpacity("1.0000")).toBeNull();
    expect(serializeSvgOpacity(0)).toBe("0");
    expect(serializeSvgOpacity(0.1234)).toBe("0.1234");
    expect(serializeSvgOpacity(1)).toBe("1");
    expect(() => serializeSvgOpacity(-0)).toThrow("invalid-svg-opacity");
    expect(() => serializeSvgOpacity(0.12345)).toThrow("invalid-svg-opacity");
    expect(() => serializeSvgOpacity(1.0001)).toThrow("invalid-svg-opacity");
  });

  it("escapes metadata without altering JSON semantics", () => {
    expect(escapeXmlText("<&>")).toBe("&lt;&amp;&gt;");
  });

  it("keeps the portable theme independent from Obsidian variables", () => {
    expect(DOCUMENT_PALETTE).toEqual(PORTABLE_PALETTE_V1);
    expect(DOCUMENT_PALETTE.dark.text).toBe("#DADADAFF");
    expect(CANONICAL_THEME_STYLESHEET).toContain("prefers-color-scheme:dark");
    expect(CANONICAL_THEME_STYLESHEET).not.toContain("--text-normal");
  });
});

describe("SVG envelope", () => {
  it("emits the required compact deterministic order", () => {
    const svg = serializeSvgEnvelope(snapshot, 148.6, {
      background: ['<path d="M 0 0 Z"/>'],
      highlights: [],
      content: ['<path d="M 1 1 Z"/>'],
    });
    expect(svg).toContain('viewBox="0 0 2048.6 148.6"');
    expect(svg).toContain('data-inkbook-revision="7"');
    expect(svg.indexOf("<style")).toBeLessThan(svg.indexOf("<metadata"));
    expect(svg.indexOf("inkbook-background")).toBeLessThan(svg.indexOf("inkbook-highlights"));
    expect(svg.indexOf("inkbook-highlights")).toBeLessThan(svg.indexOf("inkbook-content"));
    expect(svg).not.toContain("\n");
  });
});
