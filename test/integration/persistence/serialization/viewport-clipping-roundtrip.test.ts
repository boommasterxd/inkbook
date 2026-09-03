import { parseInkbookDocumentForTest } from "../../../fixtures/persistence/parse-document";
import { describe, expect, it } from "vitest";

import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { createWorkerSnapshot } from "../../../fixtures/persistence/worker-snapshot";

describe("standalone SVG viewport clipping", () => {
  it("retains out-of-viewport geometry while clipping its rendered overflow", async () => {
    const snapshot = createWorkerSnapshot(
      [
        {
          kind: "rectangle",
          id: "00000000-0000-4000-8000-000000000001",
          createdAt: 1,
          rotation: 0,
          pivot: { x: 1_150, y: 25 },
          x: -100,
          y: -50,
          width: 2_500,
          height: 150,
          style: {
            outlineColor: { type: "theme-text" },
            outlineWidth: 4,
            outlineOpacity: 1,
            outlineStyle: "solid",
            fillColor: null,
            fillOpacity: 0,
          },
        },
      ],
      3,
    );

    const encoded = serializeInkbookDocument(snapshot);

    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.value.svg).toContain("svg{overflow:hidden}");
    expect(encoded.value.svg).toContain('d="M-100-50L2400-50');
    expect(await parseInkbookDocumentForTest(encoded.value.svg)).toMatchObject({
      ok: true,
      value: { snapshot },
    });
  });
});
