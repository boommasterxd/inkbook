import { describe, expect, it } from "vitest";

import { buildClosedShapePath } from "../../../../src/domain/geometry/element-path";
import { serializeElementPaths } from "../../../../src/persistence/serialization/output/path-markup";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { validateSafeSvg } from "../../../../src/persistence/documents/safe-svg-validator";
import { parseInkbookDocumentForTest } from "../../../fixtures/persistence/parse-document";
import { rectangle } from "../../domain/geometry/fixtures";
import { createSnapshot } from "./fixtures";

describe("native star persistence", () => {
  it.each(["solid", "dashed", "dotted"] as const)(
    "round-trips a rotated filled star with %s round-join outline",
    async (outlineStyle) => {
      const shape = rectangle({ kind: "star", rotation: 37 });
      shape.style = {
        ...shape.style,
        fillColor: { type: "rgba", value: "#3B82F6FF" },
        fillOpacity: 0.4,
        outlineStyle,
      };
      const snapshot = createSnapshot([shape]);
      const path = buildClosedShapePath(shape);
      expect(path.startsWith("M")).toBe(true);
      expect(path.match(/L/gu)).toHaveLength(9);
      expect(path.endsWith("Z")).toBe(true);
      const markup = serializeElementPaths(shape).join("");
      expect(markup).toContain('fill="#3B82F6FF"');
      expect(markup).toContain('fill-opacity="0.4"');
      expect(markup).toContain('stroke-linejoin="round"');
      expect(markup.includes("stroke-dasharray=")).toBe(outlineStyle !== "solid");

      const encoded = serializeInkbookDocument(snapshot);
      expect(encoded.ok).toBe(true);
      if (!encoded.ok) return;
      expect(validateSafeSvg(encoded.value.svg)).not.toBeNull();
      const decoded = await parseInkbookDocumentForTest(encoded.value.svg);
      expect(decoded).toMatchObject({ ok: true, value: { snapshot } });
    },
  );
});
