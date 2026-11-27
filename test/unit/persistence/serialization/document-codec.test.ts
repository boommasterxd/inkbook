import { parseInkbookDocumentForTest } from "../../../fixtures/persistence/parse-document";
import { describe, expect, it } from "vitest";

import { validateInkSnapshotV1 } from "../../../../src/domain/schema/public";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { DocumentModelRuntime } from "../../../../src/persistence/worker/runtime/model/document-model";
import { createAllElementSnapshot, createSnapshot } from "./fixtures";

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
});

describe("Inkbook document parsing failures", () => {
  it("opens safe derived-path drift from the snapshot without accepting it as verified output", async () => {
    const serialized = serializeInkbookDocument(createAllElementSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const drifted = serialized.value.svg.replace("M100 150L300 150", "M101 150L301 150");
    expect(drifted).not.toBe(serialized.value.svg);

    const model = new DocumentModelRuntime();
    const unlocked = await model.unlock(drifted);
    expect(unlocked.snapshot.elements.find(({ kind }) => kind === "line")).toEqual(
      serialized.value.snapshot.elements.find(({ kind }) => kind === "line"),
    );
    expect(unlocked.requiresCanonicalRewrite).toBe(false);
    expect(await model.verifyOutput(drifted)).toBeNull();
    expect(await model.verifyOutput(serialized.value.svg)).toEqual({
      outputHash: serialized.value.hash,
      revision: serialized.value.snapshot.revision,
    });

    const parsed = await parseInkbookDocumentForTest(drifted);

    expect(parsed).toMatchObject({
      error: { code: "static-path-mismatch" },
      ok: false,
    });
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
    const unsupported = serialized.value.svg.replace("</svg>", "<desc>Extra text</desc></svg>");
    expect(await parseInkbookDocumentForTest(unsupported)).toMatchObject({
      ok: false,
      error: { code: "invalid-svg" },
    });
    const model = new DocumentModelRuntime();
    await expect(model.unlock(unsupported)).rejects.toMatchObject({ code: "invalid-svg" });
    expect(model.modelRevision).toBeNull();
  });
});

function toVersionZeroDocument(svg: string): string {
  return svg
    .replace('data-inkbook-version="1"', 'data-inkbook-version="0"')
    .replace(/ data-inkbook-snapshot-sha256="[0-9a-f]{64}"/u, "")
    .replace('"version":1', '"version":0');
}
