import { describe, expect, it } from "vitest";

import { ChunkedInkbookInputParser } from "../../../../src/persistence/serialization/chunked-input-codec";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { DocumentModelRuntime } from "../../../../src/persistence/worker/runtime/document-model";
import { createSnapshot } from "./fixtures";

const CURRENT_PATH = "M100 104L200 104A4 4 0 0 0 200 96L100 96A4 4 0 0 0 100 104Z";
const LEGACY_PATH = "M100 104L200 104A4 4 0 0 1 200 96L100 96A4 4 0 0 1 100 104Z";

function pressureDocument() {
  const snapshot = createSnapshot([
    {
      kind: "stroke",
      id: "00000000-0000-4000-8000-000000000001",
      createdAt: 0,
      tool: "pen",
      points: [100, 100, 1, 200, 100, 1],
      rotation: 0,
      pivot: { x: 150, y: 100 },
      style: {
        color: { type: "theme-text" },
        opacity: 1,
        pressureEnabled: true,
        smoothing: 0.5,
        width: 8,
      },
    },
  ]);
  const serialized = serializeInkbookDocument(snapshot);
  if (!serialized.ok) throw new Error(serialized.error.code);
  expect(serialized.value.svg).toContain(CURRENT_PATH);
  return {
    current: serialized.value.svg,
    legacy: serialized.value.svg.replace(CURRENT_PATH, LEGACY_PATH),
    snapshot,
  };
}

describe("legacy pressure-cap compatibility", () => {
  it("loads old caps across byte boundaries and rewrites them on the next export", async () => {
    const document = pressureDocument();
    const parser = new ChunkedInkbookInputParser({ inputSliceBytes: 13 });
    const bytes = new TextEncoder().encode(document.legacy);
    for (let offset = 0; offset < bytes.length; offset += 7) {
      expect((await parser.write(bytes.subarray(offset, offset + 7))).ok).toBe(true);
    }
    const parsed = await parser.finish();
    expect(parsed).toMatchObject({
      ok: true,
      value: { requiresCanonicalRewrite: true, snapshot: document.snapshot },
    });
    if (!parsed.ok) throw new Error(parsed.error.code);
    const exported = serializeInkbookDocument(parsed.value.snapshot);
    expect(exported).toMatchObject({ ok: true, value: { svg: document.current } });
  });

  it("unlocks legacy caps but verifies only newly canonical output", async () => {
    const document = pressureDocument();
    const model = new DocumentModelRuntime(() => 0);
    await expect(model.unlock(document.legacy)).resolves.toMatchObject({
      requiresCanonicalRewrite: true,
    });
    await expect(model.verifyOutput(document.legacy)).resolves.toBeNull();
    await expect(model.verifyOutput(document.current)).resolves.toMatchObject({ revision: 7 });
    await expect(model.unlock(document.current)).resolves.toMatchObject({
      requiresCanonicalRewrite: false,
    });
    model.clear();
  });

  it.each([
    ["mixed end caps", LEGACY_PATH.replace("0 0 1", "0 0 0")],
    ["invalid sweep", LEGACY_PATH.replace("0 0 1", "0 0 2")],
    ["changed radius", LEGACY_PATH.replace("A4 4", "A5 5")],
    ["changed endpoint", LEGACY_PATH.replace("200 96", "201 96")],
    ["changed side", LEGACY_PATH.replace("L200 104", "L201 104")],
  ])("rejects %s instead of treating it as a legacy path", async (_label, alteredPath) => {
    const document = pressureDocument();
    const parser = new ChunkedInkbookInputParser();
    await parser.write(
      new TextEncoder().encode(document.current.replace(CURRENT_PATH, alteredPath)),
    );
    expect(await parser.finish()).toMatchObject({
      ok: false,
      error: { code: "static-path-mismatch" },
    });
  });
});
