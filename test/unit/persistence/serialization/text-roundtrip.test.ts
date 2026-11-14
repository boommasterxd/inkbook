import { Platform } from "obsidian";
import { describe, expect, it } from "vitest";
import type {
  FontResourceV2,
  InkSnapshotV1,
  TextElementV2,
} from "../../../../src/domain/schema/public";
import { textElement } from "../../domain/schema/fixtures";
import { parseInkbookDocumentForTest } from "../../../fixtures/persistence/parse-document";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/document-codec";
import { IncrementalDocumentSerializer } from "../../../../src/persistence/serialization/output/incremental-document-serializer";
import { CanonicalMetadataCache } from "../../../../src/persistence/serialization/metadata/canonical-metadata-cache";
import { canonicalMetadataSha256 } from "../../../../src/persistence/serialization/metadata/canonical-metadata";
import { validateSafeSvg } from "../../../../src/persistence/documents/safe-svg-validator";
import { createSnapshot } from "./fixtures";
import { loadBuiltinFont } from "../../../../src/persistence/fonts/builtin-fonts";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { expandLegacyTextPaddingSteps } from "../../../../src/domain/geometry/text-padding";
import { finishGeometrySteps } from "../../../fixtures/domain/geometry-steps";
import { inspectTrustedSvgOutput } from "../../../../src/persistence/scheduling/trusted-svg-output";
import { ChunkedInkbookInputParser } from "../../../../src/persistence/serialization/input/chunked-input-codec";
import { textTableGridPathSteps } from "../../../../src/domain/geometry/text-table-grid-path";
import { textTableFrame } from "../../../fixtures/domain/text-table";

async function face(
  family: string,
  weight: number,
  style: "normal" | "italic" = "normal",
): Promise<FontResourceV2> {
  if (!Platform.isDesktop) throw new Error("Font fixtures require desktop test runtime.");
  const { createHash } = await import("node:crypto");
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(
    new URL(
      `../../../../src/persistence/fonts/assets/${family}-${weight}-${style}.woff2`,
      import.meta.url,
    ),
  );
  return {
    id: createHash("sha256").update(bytes).digest("hex"),
    family,
    weight,
    style,
    mimeType: "font/woff2",
    data: bytes.toString("base64"),
  };
}

async function fixture(): Promise<InkSnapshotV1> {
  const element = textElement();
  element.source = "Hello **world** & <ink>";
  element.style.fontFamily = "inter";
  element.backgroundColor = { type: "rgba", value: "#FFF9D9FF" };
  element.backgroundOpacity = 0.5;
  element.rotation = 15;
  element.ranges = [
    { start: 0, end: 5, style: { color: { type: "rgba", value: "#AA3300FF" }, opacity: 0.6 } },
    { start: 8, end: 13, style: { bold: true, italic: true, underline: true } },
  ];
  element.layout.lines[0]!.runs = [
    { text: "Hello ", start: 0, end: 6, x: 0, width: 42 },
    {
      text: "world & <ink>",
      start: 8,
      end: element.source.length,
      x: 42,
      width: 90,
      style: { bold: true, italic: true, underline: true },
    },
  ];
  element.layout.math = [
    {
      start: 0,
      end: 5,
      display: false,
      x: 5,
      y: 22,
      width: 10,
      height: 10,
      paths: [{ d: "M0 0L10 10L0 10Z", fillRule: "evenodd" }],
    },
  ];
  return {
    ...createSnapshot([element]),
    version: 2,
    fontResources: await Promise.all([
      face("inter", 400),
      face("inter", 700, "italic"),
      face("jetbrains-mono", 400),
    ]),
  };
}

it("keeps unpadded V2 proofs valid and persists optional padding without shifting exported glyphs or math", async () => {
  const snapshot = await fixture();
  const legacy = serializeInkbookDocument(snapshot);
  if (!legacy.ok) throw new Error(legacy.error.message);
  const element = legacy.value.snapshot.elements[0] as TextElementV2;
  expect(element.layout).not.toHaveProperty("padding");
  const padded = finishGeometrySteps(expandLegacyTextPaddingSteps(element));
  const saved = serializeInkbookDocument({ ...legacy.value.snapshot, elements: [padded] });
  if (!saved.ok) throw new Error(saved.error.message);
  expect(saved.value.snapshot.elements[0]).toMatchObject({ layout: { padding: 28 } });
  expect(saved.value.svg.match(/<text\b[\s\S]*?<\/text>/u)?.[0]).toBe(
    legacy.value.svg.match(/<text\b[\s\S]*?<\/text>/u)?.[0],
  );
  expect(saved.value.svg).toContain('transform="rotate(15 150 125) translate(105 122)"');
  for (const document of [legacy.value, saved.value]) {
    const proof = (await inspectTrustedSvgOutput(document.svg)).safeStaticProof;
    const input = new ChunkedInkbookInputParser({
      staticValidation: "safe",
      safeStaticProof: proof,
    });
    expect((await input.write(new TextEncoder().encode(document.svg))).ok).toBe(true);
    expect(await input.finish()).toMatchObject({
      ok: true,
      value: { requiresCanonicalRewrite: false, snapshot: document.snapshot },
    });
    const incremental = new IncrementalDocumentSerializer();
    expect(incremental.reset(document.snapshot).ok).toBe(true);
    expect(await incremental.serializeChunked()).toMatchObject({
      ok: true,
      value: { svg: document.svg },
    });
  }
});

it("roundtrips table frames through canonical metadata and rejects replaced or missing grid geometry", async () => {
  const snapshot = await fixture();
  const element = snapshot.elements[0] as TextElementV2;
  element.layout.tables = [textTableFrame(element.source.length)];
  const saved = serializeInkbookDocument(snapshot);
  if (!saved.ok) throw new Error(saved.error.message);
  const d = finishGeometrySteps(textTableGridPathSteps(element.layout.tables[0]!));
  expect(saved.value.svg).toContain(
    `d="${d}" class="inkbook-theme-fill" fill="#222222FF" fill-opacity="1" transform="rotate(15 150 125) translate(100 100)"`,
  );
  expect(validateSafeSvg(saved.value.svg)).not.toBeNull();
  expect(await parseInkbookDocumentForTest(saved.value.svg)).toMatchObject({
    ok: true,
    value: { snapshot: saved.value.snapshot },
  });
  const incremental = new IncrementalDocumentSerializer();
  expect(incremental.reset(snapshot).ok).toBe(true);
  expect(await incremental.serializeChunked()).toMatchObject({
    ok: true,
    value: { svg: saved.value.svg },
  });
  expect(await new CanonicalMetadataCache().digest(snapshot, () => undefined)).toBe(
    saved.value.snapshotHash,
  );
  for (const svg of [
    saved.value.svg.replace(d, d.replace("H100", "H99")),
    saved.value.svg.replace(new RegExp(`<path d="${d}"[^>]+/>`, "u"), ""),
  ]) {
    expect(validateSafeSvg(svg)).not.toBeNull();
    expect(await parseInkbookDocumentForTest(svg)).toMatchObject({
      ok: false,
      error: { code: "static-path-mismatch" },
    });
  }
  element.layout.tables[0]!.width = 0;
  element.layout.tables[0]!.borderWidth = 0;
  const narrow = serializeInkbookDocument(snapshot);
  if (!narrow.ok) throw new Error(narrow.error.message);
  expect(narrow.value.svg).not.toContain('d=""');
  expect(validateSafeSvg(narrow.value.svg)).not.toBeNull();
  expect(await parseInkbookDocumentForTest(narrow.value.svg)).toMatchObject({
    ok: true,
    value: { snapshot: narrow.value.snapshot },
  });
});

describe("inline text background documents", () => {
  it("roundtrips inline background alpha and transparent resets through the safe SVG envelope", async () => {
    const original = await fixture();
    const element = original
      .elements[0] as import("../../../../src/domain/schema/public").TextElementV2;
    const background = {
      backgroundColor: { type: "rgba" as const, value: "#113399FF" as const },
      backgroundOpacity: 0.125,
    };
    Object.assign(element.ranges[0]!.style, background);
    element.ranges.push({ start: 6, end: 8, style: { backgroundColor: null } });
    element.ranges.sort((left, right) => left.start - right.start);
    element.layout.lines[0]!.runs[0]!.style = background;
    const serialized = serializeInkbookDocument(original);
    if (!serialized.ok) throw new Error(JSON.stringify(serialized.error));
    expect(serialized.value.svg).toContain('fill="#113399FF" fill-opacity="0.125"');
    expect(serialized.value.svg).not.toMatch(/<(?:foreignObject|mask|clipPath)/u);
    expect(validateSafeSvg(serialized.value.svg)).not.toBeNull();
    const parsed = await parseInkbookDocumentForTest(serialized.value.svg);
    expect(parsed).toMatchObject({
      ok: true,
      value: { snapshot: { elements: [{ ranges: element.ranges, layout: element.layout }] } },
    });
    const incremental = new IncrementalDocumentSerializer();
    expect(incremental.reset(original).ok).toBe(true);
    expect(await incremental.serializeChunked()).toMatchObject({
      ok: true,
      value: { svg: serialized.value.svg },
    });
  });
});

describe("portable text documents", () => {
  it("shares one variable font payload across normal and bold runs after reopening", async () => {
    const font = await loadBuiltinFont("caveat", 400, "normal", new TestWorkScheduler());
    const element = textElement();
    element.source = "ab";
    element.style.fontFamily = "caveat";
    element.ranges = [{ start: 1, end: 2, style: { bold: true } }];
    element.layout.lines[0]!.runs = [
      { text: "a", start: 0, end: 1, x: 0, width: 8 },
      { text: "b", start: 1, end: 2, x: 8, width: 8, style: { bold: true } },
    ];
    const saved = serializeInkbookDocument({
      ...createSnapshot([element]),
      version: 2,
      fontResources: [font],
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.svg.match(/@font-face\{/g)).toHaveLength(1);
    expect(saved.value.svg.split(font.data)).toHaveLength(2);
    expect(saved.value.svg).toContain("font-weight:400 700");
    expect(await parseInkbookDocumentForTest(saved.value.svg)).toMatchObject({
      ok: true,
      value: { snapshot: { fontResources: [font] } },
    });
  });
  it("roundtrips rich text, placed glyphs, formulas and only used fonts through both serializers", async () => {
    const snapshot = await fixture();
    const serialized = serializeInkbookDocument(snapshot);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(serialized.value.snapshot.fontResources).toHaveLength(2);
    expect(serialized.value.svg.match(/@font-face\{/g)).toHaveLength(2);
    expect(serialized.value.svg).toContain('data-inkbook-version="2"');
    expect(serialized.value.svg).toContain("world &amp; &lt;ink&gt;");
    expect(serialized.value.svg).toContain('transform="rotate(15 150 125) translate(105 122)"');
    expect(serialized.value.svg).toContain(
      '<path d="M0 0L10 10L0 10Z" fill="#AA3300FF" fill-opacity="0.6"',
    );
    const safe = validateSafeSvg(serialized.value.svg);
    expect(safe).not.toBeNull();
    const fontBytes = serialized.value.snapshot.fontResources!.reduce((bytes, resource) => {
      expect(serialized.value.svg.split(resource.data)).toHaveLength(2);
      expect(safe!.metadataText).not.toContain(resource.data);
      return bytes + resource.data.length;
    }, 0);
    expect(serialized.value.totalBytes).toBe(
      new TextEncoder().encode(serialized.value.svg).byteLength,
    );
    expect(serialized.value.totalBytes).toBeLessThan(fontBytes + 16 * 1024);
    const reopened = await parseInkbookDocumentForTest(serialized.value.svg);
    expect(reopened).toMatchObject({ ok: true, value: { snapshot: serialized.value.snapshot } });
    const incremental = new IncrementalDocumentSerializer();
    expect(incremental.reset(snapshot)).toEqual({ ok: true, value: undefined });
    const streamed = await incremental.serializeChunked();
    expect(streamed).toMatchObject({
      ok: true,
      value: { svg: serialized.value.svg, snapshotHash: serialized.value.snapshotHash },
    });
    expect(await new CanonicalMetadataCache().digest(snapshot, () => undefined)).toBe(
      canonicalMetadataSha256(serialized.value.snapshot),
    );
    expect(
      incremental.applyDelta({
        baseModelRevision: 7,
        modelRevision: 8,
        removedIds: [snapshot.elements[0]!.id],
      }).ok,
    ).toBe(true);
    const empty = incremental.serialize();
    expect(empty).toMatchObject({ ok: true, value: { snapshot: { version: 1 } } });
    if (empty.ok) expect(empty.value.svg).not.toContain("@font-face");
  });

  it("rejects font content substitution, missing resources and unsafe text markup", async () => {
    const serialized = serializeInkbookDocument(await fixture());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const svg = serialized.value.svg;
    const tampered = svg.replace("base64,d09GM", "base64,A09GM");
    expect(await parseInkbookDocumentForTest(tampered)).toMatchObject({
      ok: false,
      error: { code: "snapshot-invalid" },
    });
    expect(validateSafeSvg(svg.replace("<tspan x=", '<tspan onclick="run()" x='))).toBeNull();
    const invalid = await fixture();
    invalid.fontResources![0] = { ...invalid.fontResources![0]!, data: "AAAA" };
    expect(serializeInkbookDocument(invalid)).toMatchObject({
      ok: false,
      error: { code: "snapshot-invalid" },
    });
    const missing = await fixture();
    missing.fontResources = [];
    expect(serializeInkbookDocument(missing)).toMatchObject({
      ok: false,
      error: { code: "snapshot-invalid" },
    });
  });
});
