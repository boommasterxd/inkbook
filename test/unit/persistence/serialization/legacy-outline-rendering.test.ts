import { describe, expect, it } from "vitest";

import { ChunkedInkbookInputParser } from "../../../../src/persistence/serialization/chunked-input-codec";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/document-codec";
import { parseInkbookDocumentForTest } from "../../../fixtures/persistence/parse-document";
import {
  serializeElementPaths,
  serializeProfileElementPaths,
} from "../../../../src/persistence/serialization/path-markup";
import { createAllElementSnapshot } from "./fixtures";

import { ROUNDED_OUTLINE_SVG as rounded } from "../../../fixtures/persistence/rounded-outline-rendering";
import { LEGACY_OUTLINE_SVG as legacy } from "../../../fixtures/persistence/legacy-outline-rendering";

function currentSvg(): string {
  const result = serializeInkbookDocument(createAllElementSnapshot());
  if (!result.ok) throw new Error(result.error.code);
  return result.value.svg;
}

describe("previous outline rendering compatibility", () => {
  it.each([
    { name: "legacy", svg: legacy, slice: 1 },
    { name: "legacy", svg: legacy, slice: 37 },
    { name: "legacy", svg: legacy, slice: 16_384 },
    { name: "rounded", svg: rounded, slice: 1 },
    { name: "rounded", svg: rounded, slice: 37 },
    { name: "rounded", svg: rounded, slice: 16_384 },
  ])("loads exact $name markup across $slice-byte slices", async ({ svg, slice }) => {
    const parser = new ChunkedInkbookInputParser({ inputSliceBytes: slice });
    expect((await parser.write(new TextEncoder().encode(svg))).ok).toBe(true);
    const result = await parser.finish();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.requiresCanonicalRewrite).toBe(true);
    expect(parser.maximumRetainedStaticInputCharacters).toBeLessThanOrEqual(slice + 16);
    const rewritten = serializeInkbookDocument(result.value.snapshot);
    expect(rewritten.ok).toBe(true);
    if (!rewritten.ok) throw new Error(rewritten.error.code);
    const reloaded = await parseInkbookDocumentForTest(rewritten.value.svg);
    expect(reloaded.ok && reloaded.value.requiresCanonicalRewrite).toBe(false);
  });

  it("accepts current rounded markup without scheduling a rewrite", async () => {
    const result = await parseInkbookDocumentForTest(currentSvg());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.requiresCanonicalRewrite).toBe(false);
  });

  it("rejects mixed symmetric and previous patterned-head profiles across elements", async () => {
    const parsed = await parseInkbookDocumentForTest(rounded);
    if (!parsed.ok) throw new Error(parsed.error.code);
    const arrow = parsed.value.snapshot.elements.find(
      (element) => element.kind === "arrow" && element.endNode === "arrow",
    )!;
    const previousParts = serializeProfileElementPaths(arrow, "rounded");
    const currentParts = serializeElementPaths(arrow);
    expect(currentParts).toHaveLength(1);
    const current = serializeInkbookDocument(parsed.value.snapshot);
    if (!current.ok) throw new Error(current.error.code);
    for (const input of [
      rounded.replace(previousParts.join(""), currentParts.join("")),
      current.value.svg.replace(currentParts.join(""), previousParts.join("")),
      current.value.svg.replace('stroke-dasharray="16 12"', 'stroke-dasharray="12 12"'),
    ]) {
      expect(input).not.toBe(rounded);
      expect(input).not.toBe(current.value.svg);
      expect(await parseInkbookDocumentForTest(input)).toMatchObject({
        ok: false,
        error: { code: "static-path-mismatch" },
      });
    }
  });

  it("rejects mixed caps and mixed sharp/rounded arrow geometry", async () => {
    const current = currentSvg();
    const legacyFill = legacy.match(/<path d="[^"]+" fill="#AA1122FF"[^>]*\/>/u)?.[0];
    const currentFill = current.match(/<path d="[^"]+" fill="#AA1122FF"[^>]*\/>/u)?.[0];
    expect(legacyFill).toBeDefined();
    expect(currentFill).toBeDefined();
    expect(legacyFill).not.toBe(currentFill);
    for (const input of [
      legacy.replace(
        'stroke-linecap="butt" stroke-linejoin="round"',
        'stroke-linecap="round" stroke-linejoin="round"',
      ),
      current.replace(currentFill!, legacyFill!),
      legacy.replace(legacyFill!, currentFill!),
      legacy.replace('stroke-width="4"', 'stroke-width="5"'),
    ]) {
      const result = await parseInkbookDocumentForTest(input);
      expect(result).toMatchObject({ ok: false, error: { code: "static-path-mismatch" } });
    }
  });
});
