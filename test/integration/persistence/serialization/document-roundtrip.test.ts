import { parseInkbookDocumentForTest } from "../../../fixtures/persistence/parse-document";
import { describe, expect, it } from "vitest";

import type { InkSnapshotV1 } from "../../../../src/domain/schema/public";
import { validateSafeSvg } from "../../../../src/persistence/documents/safe-svg-validator";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";

describe("document codec integration", () => {
  it("keeps render-band order, portable paint, and metadata through standalone SVG", async () => {
    const snapshot: InkSnapshotV1 = {
      format: "inkbook",
      version: 1,
      revision: 42,
      page: {
        innerWidth: 2000,
        margin: 24.3,
        background: { type: "squares", spacing: 25 },
        activeBufferLines: 3,
        lockedBufferLines: 1,
      },
      elements: [
        {
          kind: "stroke",
          tool: "highlighter",
          id: "00000000-0000-4000-8000-000000000001",
          createdAt: 1,
          rotation: 0,
          pivot: { x: 150, y: 100 },
          points: [100, 100, 0.5, 200, 100, 0.5],
          style: {
            color: { type: "rgba", value: "#FFFF0080" },
            width: 8,
            opacity: 0.5,
            pressureEnabled: false,
            smoothing: 0.5,
          },
        },
        {
          kind: "rectangle",
          id: "00000000-0000-4000-8000-000000000002",
          createdAt: 2,
          rotation: 30,
          pivot: { x: 350, y: 200 },
          x: 300,
          y: 150,
          width: 100,
          height: 100,
          style: {
            outlineColor: { type: "theme-text" },
            outlineWidth: 4,
            outlineOpacity: 1,
            outlineStyle: "solid",
            fillColor: { type: "theme-text" },
            fillOpacity: 0.25,
          },
        },
      ],
    };

    const encoded = serializeInkbookDocument(snapshot);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const safe = validateSafeSvg(encoded.value.svg);
    const parsed = await parseInkbookDocumentForTest(encoded.value.svg);

    expect(safe).toMatchObject({ revision: 42 });
    expect(parsed).toMatchObject({ ok: true, value: { snapshot } });
    expect(encoded.value.svg.indexOf("inkbook-highlights")).toBeLessThan(
      encoded.value.svg.indexOf("inkbook-content"),
    );
    expect(encoded.value.svg).toContain('class="inkbook-theme-stroke-fill" fill="#222222FF"');
  });
});
