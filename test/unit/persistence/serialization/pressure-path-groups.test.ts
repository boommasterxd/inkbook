import { describe, expect, it } from "vitest";

import { ChunkedInkbookInputParser } from "../../../../src/persistence/serialization/input/chunked-input-codec";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { DocumentModelRuntime } from "../../../../src/persistence/worker/runtime/model/document-model";
import { createSnapshot } from "./fixtures";

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
  return { current: serialized.value.svg, snapshot };
}

describe("canonical pressure path groups", () => {
  it("round-trips pressure parts across byte boundaries without a rewrite", async () => {
    const document = pressureDocument([100, 100, 0, 150, 100, 0.5, 200, 100, 1]);
    expect(document.current).toContain('<g id="inkbook-content"><g opacity="1"><path');
    const parser = new ChunkedInkbookInputParser({ inputSliceBytes: 13 });
    const bytes = new TextEncoder().encode(document.current);
    for (let offset = 0; offset < bytes.length; offset += 7) {
      expect((await parser.write(bytes.subarray(offset, offset + 7))).ok).toBe(true);
    }
    const parsed = await parser.finish();
    expect(parsed).toMatchObject({ ok: true, value: { requiresCanonicalRewrite: false } });
    if (!parsed.ok) return;
    const stroke = parsed.value.snapshot.elements[0];
    expect(stroke?.kind).toBe("stroke");
    if (stroke?.kind !== "stroke") return;
    expect(stroke.points).toEqual(new Float64Array([100, 100, 0, 150, 100, 0.5, 200, 100, 1]));
    const model = new DocumentModelRuntime();
    await expect(model.verifyOutput(document.current)).resolves.toMatchObject({ revision: 7 });
    await expect(model.unlock(document.current)).resolves.toMatchObject({
      requiresCanonicalRewrite: false,
    });
    model.clear();
  });

  it.each([
    ["group opacity", true, (svg: string) => svg.replace('<g opacity="1">', '<g opacity="0.5">')],
    [
      "path geometry",
      true,
      (svg: string) => svg.replace(/(<g opacity="1"><path d=")[^"]+/u, "$1M0 0L1 1Z"),
    ],
    ["part color", false, (svg: string) => svg.replace('fill="#222222FF"', 'fill="#212122FF"')],
    [
      "extra path",
      false,
      (svg: string) => svg.replace('<g opacity="1">', '<g opacity="1"><path d="M0 0L1 1"/>'),
    ],
  ])(
    "enforces safe unlock and strict output rules for changed %s",
    async (_label, safe, change) => {
      const document = pressureDocument();
      const model = new DocumentModelRuntime();
      await expect(model.verifyOutput(change(document.current))).resolves.toBeNull();
      if (safe) {
        await expect(model.unlock(change(document.current))).resolves.toMatchObject({
          snapshot: { revision: document.snapshot.revision },
          requiresCanonicalRewrite: false,
        });
        await expect(model.verifyOutput(change(document.current))).resolves.toBeNull();
      } else {
        await expect(model.unlock(change(document.current))).rejects.toThrow("invalid-svg");
      }
      model.clear();
    },
  );

  it("accepts safe legacy pressure presentation for unlock but rejects it as canonical output", async () => {
    const document = pressureDocument();
    const legacy = document.current.replace(
      /<g opacity="1">.*?<\/g>/u,
      '<path d="M100 104L200 104A4 4 0 0 0 200 96L100 96A4 4 0 0 0 100 104Z" class="inkbook-theme-fill" fill="#222222FF"/>',
    );
    const model = new DocumentModelRuntime();
    await expect(model.unlock(legacy)).resolves.toMatchObject({ requiresCanonicalRewrite: false });
    await expect(model.verifyOutput(legacy)).resolves.toBeNull();
    model.clear();
  });

  it("preserves nearby continuous pressure changes in static geometry", () => {
    const first = pressureDocument([100, 100, 0.4]);
    const second = pressureDocument([100, 100, 0.401]);
    const content = (svg: string) => svg.split('<g id="inkbook-content">')[1]!;
    expect(content(first.current)).not.toBe(content(second.current));
    expect(content(first.current).match(/<path /gu)).toHaveLength(1);
    expect(content(first.current)).not.toContain("stroke-width=");
  });

  it("applies translucent color and opacity once to the pressure outline", () => {
    const snapshot = pressureDocument([100, 100, 0, 150, 100, 0.5, 200, 100, 1]).snapshot;
    const element = snapshot.elements[0]!;
    if (element.kind !== "stroke") throw new Error("Expected stroke");
    element.style = { ...element.style, color: { type: "rgba", value: "#12345680" }, opacity: 0.5 };
    const serialized = serializeInkbookDocument(snapshot);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) throw new Error(serialized.error.code);
    expect(serialized.value.svg).toContain('<g opacity="0.251">');
    const content = serialized.value.svg.split('<g id="inkbook-content">')[1]!;
    expect(content).toContain('fill="#123456FF"');
    expect(content).not.toContain("stroke-opacity=");
    expect(content).not.toContain("fill-opacity=");
  });
});
