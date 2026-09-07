import { describe, expect, it } from "vitest";

import { ChunkedInkbookInputParser } from "../../../../src/persistence/serialization/chunked-input-codec";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { DocumentModelRuntime } from "../../../../src/persistence/worker/runtime/document-model";
import { createSnapshot } from "./fixtures";

const OLD_PATH = "M100 104L200 104A4 4 0 0 0 200 96L100 96A4 4 0 0 0 100 104Z";
const LEGACY_PATH = "M100 104L200 104A4 4 0 0 1 200 96L100 96A4 4 0 0 1 100 104Z";

function pressureDocument(points = [100, 100, 1, 200, 100, 1], rotation = 0) {
  const snapshot = createSnapshot([
    {
      kind: "stroke",
      id: "00000000-0000-4000-8000-000000000001",
      createdAt: 0,
      tool: "pen",
      points,
      rotation,
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
  const currentPath = serialized.value.svg.match(/<g id="inkbook-content"><path d="([^"]+)"/u)?.[1];
  if (currentPath === undefined) throw new Error("Missing pressure path.");
  return {
    current: serialized.value.svg,
    currentPath,
    old: serialized.value.svg.replace(currentPath, OLD_PATH),
    legacy: serialized.value.svg.replace(currentPath, LEGACY_PATH),
    snapshot,
  };
}

describe("legacy pressure-cap compatibility", () => {
  it.each(["old", "legacy"] as const)(
    "loads %s outlines across byte boundaries and rewrites them on export",
    async (variant) => {
      const document = pressureDocument();
      const parser = new ChunkedInkbookInputParser({ inputSliceBytes: 13 });
      const bytes = new TextEncoder().encode(document[variant]);
      for (let offset = 0; offset < bytes.length; offset += 7) {
        expect((await parser.write(bytes.subarray(offset, offset + 7))).ok).toBe(true);
      }
      const parsed = await parser.finish();
      expect(parsed).toMatchObject({
        ok: true,
        value: {
          requiresCanonicalRewrite: document[variant] !== document.current,
          snapshot: document.snapshot,
        },
      });
      if (!parsed.ok) throw new Error(parsed.error.code);
      const exported = serializeInkbookDocument(parsed.value.snapshot);
      expect(exported).toMatchObject({ ok: true, value: { svg: document.current } });
    },
  );

  it("unlocks legacy caps but verifies only newly canonical output", async () => {
    const document = pressureDocument();
    const model = new DocumentModelRuntime(() => 0);
    await expect(model.unlock(document.legacy)).resolves.toMatchObject({
      requiresCanonicalRewrite: true,
    });
    await expect(model.verifyOutput(document.legacy)).resolves.toBeNull();
    expect(await model.verifyOutput(document.old)).toEqual(
      document.old === document.current ? expect.objectContaining({ revision: 7 }) : null,
    );
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
      new TextEncoder().encode(document.current.replace(document.currentPath, alteredPath)),
    );
    expect(await parser.finish()).toMatchObject({
      ok: false,
      error: { code: "static-path-mismatch" },
    });
  });
});

describe("historical pressure-outline integrity", () => {
  it.each([
    {
      label: "pressure-varying midpoint curves",
      points: [100, 100, 1, 150, 100, 0.5, 200, 100, 1],
      rotation: 0,
      path: "M100 104L125 103.35Q150 102.7 175 103.35L200 104A4 4 0 0 0 200 96L175 96.65Q150 97.3 125 96.65L100 96A4 4 0 0 0 100 104Z",
    },
    {
      label: "rotated pressure outline",
      points: [100, 100, 1, 200, 100, 1],
      rotation: 90,
      path: "M146 50L146 150A4 4 0 0 0 154 150L154 50A4 4 0 0 0 146 50Z",
    },
    {
      label: "repeated centers",
      points: [100, 100, 1, 100, 100, 1, 100, 100, 1],
      rotation: 0,
      path: "M100 104L100 104Q100 104 100 104L100 104A4 4 0 0 0 100 96L100 96Q100 96 100 96L100 96A4 4 0 0 0 100 104Z",
    },
    {
      label: "single sample",
      points: [100, 100, 1],
      rotation: 0,
      path: "M96 100A4 4 0 0 1 104 100A4 4 0 0 1 96 100Z",
    },
  ])(
    "loads historical $label without permitting changed paint",
    async ({ points, rotation, path }) => {
      const document = pressureDocument(points, rotation);
      const historical = document.current.replace(document.currentPath, path);
      const model = new DocumentModelRuntime(() => 0);
      const loaded = await model.unlock(historical);
      expect(loaded.snapshot.elements[0]).toMatchObject({
        points: new Float64Array(points),
        rotation,
      });
      expect(loaded.requiresCanonicalRewrite).toBe(historical !== document.current);
      await expect(model.verifyOutput(document.current)).resolves.toMatchObject({ revision: 7 });
      if (historical !== document.current) {
        await expect(model.verifyOutput(historical)).resolves.toBeNull();
      }
      await expect(
        model.unlock(historical.replace('fill="#222222FF"', 'fill="#212122FF"')),
      ).rejects.toThrow("static-path-mismatch");
      model.clear();
    },
  );
});
