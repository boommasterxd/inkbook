import { parseInkbookDocumentForTest } from "../../../fixtures/persistence/parse-document";
import { describe, expect, it } from "vitest";

import { FILE_SCHEMA_LIMITS, validateInkSnapshotV1 } from "../../../../src/domain/schema/public";
import { jsonContainerBudget } from "../../../../src/domain/schema/validation-internals";
import { validateSafeSvg } from "../../../../src/persistence/documents/safe-svg-validator";
import {
  CURRENT_METADATA_REWRITES,
  rewriteDocumentMetadata,
} from "../../../fixtures/persistence/metadata-rewrite";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { sha256Hex, type DocumentHashPort } from "../../../../src/persistence/serialization/sha256";
import { CANONICAL_THEME_STYLESHEET } from "../../../../src/persistence/documents/svg-theme";
import {
  appendMetadataProperty,
  createAllElementSnapshot,
  createDottedRectangleSnapshot,
  createSnapshot,
  wideMetadataArrayProperty,
} from "./fixtures";

describe("Inkbook document serialization", () => {
  it("emits deterministic standalone geometry and compact canonical metadata", () => {
    const first = serializeInkbookDocument(createAllElementSnapshot());
    const second = serializeInkbookDocument(createAllElementSnapshot());

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.svg).toBe(second.value.svg);
    expect(first.value.hash).toBe(second.value.hash);
    expect(first.value.svg).not.toContain("\n");
    expect(first.value.svg).not.toContain('d="M ');
    expect(first.value.svg).not.toContain("transform=");
    expect(first.value.svg).toContain('class="inkbook-theme-page"');
    expect(first.value.svg).toContain('class="inkbook-theme-guide"');
    expect(first.value.svg).toContain('class="inkbook-theme-stroke-fill"');
    expect(first.value.svg).toContain('stroke-dasharray="16 12"');
    expect(first.value.svg).toContain('stroke-dasharray="0 10"');
    expect(first.value.svg).toContain('fill-opacity="0.75"');
    expect(first.value.svg).toContain('stroke-opacity="0.8"');
    expect(validateSafeSvg(first.value.svg)).not.toBeNull();
  });

  it("omits SVG attributes whose values equal rendering defaults", () => {
    const snapshot = createAllElementSnapshot();
    for (const element of snapshot.elements) {
      if (element.kind === "stroke" || element.kind === "straight-highlighter") {
        Object.assign(element.style, { opacity: 1 });
      } else {
        Object.assign(element.style, { outlineOpacity: 1 });
        if ("fillOpacity" in element.style) Object.assign(element.style, { fillOpacity: 1 });
      }
    }

    const result = serializeInkbookDocument(snapshot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.svg).not.toContain('fill-opacity="1"');
    expect(result.value.svg).not.toContain('stroke-opacity="1"');
    expect(result.value.svg).not.toContain('fill-rule="nonzero"');
    expect(result.value.svg).not.toContain('stroke="none"');
    expect(validateSafeSvg(result.value.svg)).not.toBeNull();
  });

  it("round-trips custom table separators while preserving legacy equal columns", async () => {
    const custom = createAllElementSnapshot();
    const customTable = custom.elements.find((element) => element.kind === "table");
    expect(customTable?.kind).toBe("table");
    if (customTable?.kind !== "table") return;
    customTable.columnOffsets = [140, 250];

    const serialized = serializeInkbookDocument(custom);

    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(
      serialized.value.snapshot.elements.find((element) => element.kind === "table"),
    ).toMatchObject({
      columnOffsets: [140, 250],
    });
    expect(serialized.value.svg).toContain("M1260 400L1260 500");
    expect(serialized.value.svg).toContain("M1370 400L1370 500");

    const parsed = await parseInkbookDocumentForTest(serialized.value.svg);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.snapshot.elements).toHaveLength(custom.elements.length);
    expect(
      parsed.value.snapshot.elements.find((element) => element.kind === "table"),
    ).toMatchObject({
      columnOffsets: [140, 250],
    });

    const legacy = serializeInkbookDocument(createAllElementSnapshot());
    expect(legacy.ok).toBe(true);
    if (legacy.ok) expect(legacy.value.svg).not.toContain('"columnOffsets"');
  });
});

describe("Inkbook background serialization", () => {
  it.each([
    { type: "none" as const },
    { type: "lines" as const, spacing: 50 as const },
    { type: "dots" as const, spacing: 100 as const },
    { type: "squares" as const, spacing: 100 as const },
  ])("serializes the $type background into a safe page", (background) => {
    const snapshot = createSnapshot();
    snapshot.page.background = background;

    const result = serializeInkbookDocument(snapshot);

    expect(result.ok).toBe(true);
    if (result.ok) expect(validateSafeSvg(result.value.svg)).not.toBeNull();
  });

  it("keeps the square frame fixed and writes all four outer boundaries", () => {
    const result = serializeSquareBackground();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.svg).toContain("M24.3 24.3L2024.3 24.3");
    expect(result.value.svg).toContain("M24.3 324.3L2024.3 324.3");
    expect(result.value.svg).toContain("M24.3 24.3L24.3 324.3");
    expect(result.value.svg).toContain("M2024.3 24.3L2024.3 324.3");
  });

  it("serializes exactly one trailing pattern row below occupied content", () => {
    const snapshot = createDottedRectangleSnapshot(400);
    snapshot.page.background = { spacing: 25, type: "lines" };

    const result = serializeInkbookDocument(snapshot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lockedHeight).toBeCloseTo(573.6);
    expect(result.value.svg).toContain("M24.3 549.3L2024.3 549.3");
    expect(result.value.svg).not.toContain("M24.3 574.3L2024.3 574.3");
    expect(validateSafeSvg(result.value.svg)).not.toBeNull();
  });

  it("loads version-one files written before scale-independent guide styling", async () => {
    const result = serializeSquareBackground();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const previousStylesheet = CANONICAL_THEME_STYLESHEET.replace(
      ";vector-effect:non-scaling-stroke",
      "",
    );
    const previousFile = result.value.svg.replace(CANONICAL_THEME_STYLESHEET, previousStylesheet);

    expect(previousFile).not.toBe(result.value.svg);
    expect(validateSafeSvg(previousFile)).not.toBeNull();
    expect(await parseInkbookDocumentForTest(previousFile)).toMatchObject({
      ok: true,
      value: {
        requiresCanonicalRewrite: true,
        snapshot: { page: { background: { type: "squares", spacing: 50 } } },
      },
    });
  });
});

describe("Inkbook document serialization boundaries", () => {
  it("chunks large dot backgrounds within per-path command limits", () => {
    const snapshot = createDottedRectangleSnapshot(4000);

    const result = serializeInkbookDocument(snapshot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateSafeSvg(result.value.svg)).toMatchObject({ paths: 4 });
  });

  it("rejects an invalid snapshot before constructing static paths", () => {
    const snapshot = createSnapshot();
    snapshot.page.activeBufferLines = 0;

    expect(serializeInkbookDocument(snapshot)).toMatchObject({
      ok: false,
      error: { code: "snapshot-invalid", validationError: { code: "invalid-range" } },
    });
  });

  it("rejects a dense dotted background before constructing its paths", () => {
    const snapshot = createDottedRectangleSnapshot(990_000);

    expect(serializeInkbookDocument(snapshot)).toMatchObject({
      ok: false,
      error: { code: "static-output-limit-exceeded" },
    });
  });

  it("supports the same injected hash port for worker and fallback execution", () => {
    const hasher: DocumentHashPort = { hash: (input) => `bytes:${String(input).length}` };

    const result = serializeInkbookDocument(createSnapshot(), hasher);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.hash.startsWith("bytes:")).toBe(true);
  });
});

describe("Inkbook document parsing security boundaries", () => {
  it.each(CURRENT_METADATA_REWRITES)(
    "rejects noncanonical or unbound current metadata as $expectedCode",
    async ({ expectedCode, mutate, updateHash }) => {
      const serialized = serializeInkbookDocument(createSnapshot());
      expect(serialized.ok).toBe(true);
      if (!serialized.ok) return;
      const rewritten = rewriteDocumentMetadata(serialized.value.svg, mutate, updateHash);

      expect(await parseInkbookDocumentForTest(rewritten)).toMatchObject({
        error: { code: expectedCode },
        ok: false,
      });
    },
  );

  it("rejects metadata container width before native JSON materialization", async () => {
    const serialized = serializeInkbookDocument(createSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const maximumEntries = jsonContainerBudget(FILE_SCHEMA_LIMITS);
    const atLimit = appendMetadataProperty(
      serialized.value.svg,
      wideMetadataArrayProperty(maximumEntries),
    );
    const overLimit = appendMetadataProperty(
      serialized.value.svg,
      wideMetadataArrayProperty(maximumEntries + 1),
    );

    expect(await parseInkbookDocumentForTest(atLimit)).toMatchObject({
      error: { code: "snapshot-invalid" },
      ok: false,
    });
    expect(await parseInkbookDocumentForTest(overLimit)).toMatchObject({
      error: { code: "invalid-json" },
      ok: false,
    });
  });
});

describe("SVG numeric precision", () => {
  it("preserves canonical four-decimal opacity in static presentation attributes", async () => {
    const snapshot = createAllElementSnapshot();
    const stroke = snapshot.elements.find((element) => element.kind === "stroke");
    expect(stroke?.kind).toBe("stroke");
    if (stroke?.kind !== "stroke") return;
    Object.assign(stroke.style, { opacity: 0.1234 });

    const serialized = serializeInkbookDocument(snapshot);

    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(serialized.value.svg).toContain('fill-opacity="0.1234"');
    expect(serialized.value.svg).toContain('"opacity":0.1234');
    expect(await parseInkbookDocumentForTest(serialized.value.svg)).toMatchObject({ ok: true });
  });
});

describe("Inkbook document parsing", () => {
  it("round-trips UTF-8 bytes and verifies revision, height, and hash", async () => {
    const serialized = serializeInkbookDocument(createAllElementSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;

    const parsed = await parseInkbookDocumentForTest(
      new TextEncoder().encode(serialized.value.svg),
    );
    const validation = validateInkSnapshotV1(serialized.value.snapshot);
    if (!validation.ok) throw new Error(validation.error.message);

    expect(parsed).toEqual({
      ok: true,
      value: {
        derivations: validation.derivations,
        hash: serialized.value.hash,
        lockedHeight: serialized.value.lockedHeight,
        requiresCanonicalRewrite: false,
        snapshot: serialized.value.snapshot,
        sourceVersion: 1,
      },
    });
  });
});

describe("Inkbook document migration", () => {
  it("migrates a canonical version zero envelope before adopting its snapshot", async () => {
    const serialized = serializeInkbookDocument(createAllElementSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const versionZero = toVersionZeroDocument(serialized.value.svg);

    const parsed = await parseInkbookDocumentForTest(versionZero);

    expect(parsed).toMatchObject({
      ok: true,
      value: { snapshot: { version: 1 }, sourceVersion: 0 },
    });
  });

  it("rejects a malformed version zero migration without adopting partial output", async () => {
    const serialized = serializeInkbookDocument(createSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const malformed = toVersionZeroDocument(serialized.value.svg).replace(
      '"activeBufferLines":3',
      '"activeBufferLines":0',
    );

    expect(await parseInkbookDocumentForTest(malformed)).toMatchObject({
      error: { code: "migration-failed" },
      ok: false,
    });
  });
});

describe("Inkbook document parsing failures", () => {
  it("rejects safe derived-path drift instead of opening altered static geometry", async () => {
    const serialized = serializeInkbookDocument(createAllElementSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const drifted = serialized.value.svg.replace("M100 150L300 150", "M101 150L301 150");
    expect(drifted).not.toBe(serialized.value.svg);

    const parsed = await parseInkbookDocumentForTest(drifted);

    expect(parsed).toMatchObject({
      error: { code: "static-path-mismatch" },
      ok: false,
    });
  });

  it("keeps a migrated document read-only when its static geometry differs", async () => {
    const serialized = serializeInkbookDocument(createAllElementSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const drifted = toVersionZeroDocument(serialized.value.svg).replace(
      "M100 150L300 150",
      "M101 150L301 150",
    );

    expect(await parseInkbookDocumentForTest(drifted)).toMatchObject({
      error: { code: "static-path-mismatch" },
      ok: false,
    });
  });

  it("rejects revision and locked-height mismatches", async () => {
    const serialized = serializeInkbookDocument(createSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;

    expect(
      await parseInkbookDocumentForTest(
        serialized.value.svg.replace('data-inkbook-revision="7"', 'data-inkbook-revision="8"'),
      ),
    ).toMatchObject({ ok: false, error: { code: "revision-mismatch" } });
    expect(
      await parseInkbookDocumentForTest(
        serialized.value.svg.replace('viewBox="0 0 2048.6 348.6"', 'viewBox="0 0 2048.6 349.6"'),
      ),
    ).toMatchObject({ ok: false, error: { code: "locked-height-mismatch" } });
  });

  it("rejects malformed UTF-8, JSON, and unsafe SVG markup", async () => {
    expect(await parseInkbookDocumentForTest(new Uint8Array([0xc3, 0x28]))).toMatchObject({
      ok: false,
      error: { code: "invalid-utf8" },
    });
    const serialized = serializeInkbookDocument(createSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(
      await parseInkbookDocumentForTest(
        serialized.value.svg.replace('"format":"inkbook"', '"format":'),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid-json" },
    });
    expect(
      await parseInkbookDocumentForTest(serialized.value.svg.replace("</svg>", "<script/></svg>")),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid-svg" },
    });
  });

  it("hashes the exact persisted UTF-8 bytes, including a byte-order mark", async () => {
    const serialized = serializeInkbookDocument(createSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const documentBytes = new TextEncoder().encode(serialized.value.svg);
    const bytesWithBom = new Uint8Array(documentBytes.length + 3);
    bytesWithBom.set([0xef, 0xbb, 0xbf]);
    bytesWithBom.set(documentBytes, 3);

    const parsed = await parseInkbookDocumentForTest(bytesWithBom);

    expect(parsed).toMatchObject({ ok: true, value: { hash: sha256Hex(bytesWithBom) } });
  });
});

function toVersionZeroDocument(svg: string): string {
  return svg
    .replace('data-inkbook-version="1"', 'data-inkbook-version="0"')
    .replace(/ data-inkbook-snapshot-sha256="[0-9a-f]{64}"/u, "")
    .replace('"version":1', '"version":0');
}

function serializeSquareBackground() {
  const snapshot = createSnapshot();
  snapshot.page.background = { type: "squares", spacing: 50 };
  return serializeInkbookDocument(snapshot);
}
