import { describe, expect, it } from "vitest";
import { convertObsidianInk } from "../../../../../src/persistence/import/obsidian-ink/convert";
import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/public";
import { parseInkbookDocumentForTest } from "../../../../fixtures/persistence/parse-document";
import { canvasSnapshot, inkSvg, tldrawSnapshot } from "./fixtures";

const options = () => ({
  timestamp: 1234,
  signal: new AbortController().signal,
  checkpoint: () => undefined,
});

describe("Obsidian Ink handwritten document conversion", () => {
  it("preserves official v1 placement, text color and transcript as native compact metadata", async () => {
    const imported = await convertObsidianInk(
      inkSvg(canvasSnapshot(), "ink-canvas", "<transcript>A &amp; B &lt; C&#10;next</transcript>"),
      options(),
    );
    expect(imported.snapshot.page).toEqual({
      innerWidth: 2000,
      margin: 24.3,
      activeBufferLines: 2,
      lockedBufferLines: 1,
      background: { type: "lines", spacing: 100 },
    });
    expect(imported.snapshot.elements[0]).toMatchObject({
      kind: "stroke",
      createdAt: 1234,
      offset: { x: 34.3, y: 44.3 },
      style: {
        color: { type: "theme-text" },
        pressureEnabled: true,
      },
    });
    const points = imported.snapshot.elements[0];
    if (points?.kind !== "stroke") throw new Error("Expected imported handwriting.");
    expect([
      points.points[0],
      points.points[1],
      points.points[points.points.length - 3],
      points.points[points.points.length - 2],
    ]).toEqual([0, 0, 20, 30]);
    expect(imported.transcript).toBe("A & B < C\nnext");
    const serialized = serializeInkbookDocument(imported.snapshot);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) throw new Error(serialized.error.message);
    const parsed = await parseInkbookDocumentForTest(serialized.value.svg);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.snapshot).toEqual(imported.snapshot);
  });
});

describe("Legacy tldraw handwriting", () => {
  it("converts official legacy .writing JSON and tldraw SVG through the same native output", async () => {
    const snapshot = tldrawSnapshot();
    const json = await convertObsidianInk(
      JSON.stringify({
        meta: { pluginVersion: "0.4.0", tldrawVersion: "2.1.0" },
        tldraw: snapshot,
        previewUri: "data:image/png;base64,unused",
      }),
      {
        ...options(),
        legacyWriting: true,
      },
    );
    const svg = await convertObsidianInk(inkSvg(snapshot, "tldraw"), options());
    expect(json.snapshot).toEqual(svg.snapshot);
    expect(svg.snapshot.elements[0]).toMatchObject({
      points: [0, 0, 0.2, 10, 20, 0.8],
      offset: { x: 124.3, y: 224.3 },
      style: { width: 4 },
    });
    expect(svg.warnings.some((warning) => warning.includes("stash"))).toBe(true);
  });
});
