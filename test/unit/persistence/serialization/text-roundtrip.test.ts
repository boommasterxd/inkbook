import { Platform } from "obsidian";
import { describe, expect, it } from "vitest";
import type { FontResourceV2, InkSnapshotV1 } from "../../../../src/domain/schema/public";
import { textElement } from "../../domain/schema/fixtures";
import { parseInkbookDocumentForTest } from "../../../fixtures/persistence/parse-document";
import type { SerializedInkbookDocument } from "../../../../src/persistence/serialization/types";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/document-codec";
import { IncrementalDocumentSerializer } from "../../../../src/persistence/serialization/output/incremental-document-serializer";
import { CanonicalMetadataCache } from "../../../../src/persistence/serialization/metadata/canonical-metadata-cache";
import { canonicalMetadataSha256 } from "../../../../src/persistence/serialization/metadata/canonical-metadata";
import { validateSafeSvg } from "../../../../src/persistence/documents/safe-svg-validator";
import { createSnapshot } from "./fixtures";

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

async function expectIncrementalExport(snapshot: InkSnapshotV1, saved: SerializedInkbookDocument) {
  const incremental = new IncrementalDocumentSerializer();
  expect(incremental.reset(snapshot)).toEqual({ ok: true, value: undefined });
  expect(await incremental.serializeChunked()).toMatchObject({
    ok: true,
    value: { svg: saved.svg, snapshotHash: saved.snapshotHash },
  });
  return incremental;
}

describe("portable text documents", () => {
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
    const incremental = await expectIncrementalExport(snapshot, serialized.value);
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
