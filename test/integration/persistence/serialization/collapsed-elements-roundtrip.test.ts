import { describe, expect, it } from "vitest";

import { serializeElementPaths } from "../../../../src/persistence/serialization/output/path-markup";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { collapsedElements } from "../../../fixtures/domain/collapsed-elements";
import { parseInkbookDocumentForTest } from "../../../fixtures/persistence/parse-document";
import { createWorkerSnapshot } from "../../../fixtures/persistence/worker-snapshot";

describe("collapsed geometry persistence", () => {
  it.each(["solid", "dashed", "dotted"] as const)(
    "paints point geometry with %s outlines as round dots",
    (outlineStyle) => {
      for (const element of collapsedElements(0)) {
        if (element.kind === "stroke" || element.kind === "straight-highlighter") continue;
        element.style.outlineStyle = outlineStyle;
        const paths = serializeElementPaths(element);
        expect(paths, element.kind).toHaveLength(1);
        expect(paths[0], element.kind).toContain('stroke-linecap="round"');
        expect(paths[0], element.kind).not.toContain("stroke-dasharray");
      }
    },
  );

  it.each([0, 0.001])("roundtrips all shape kinds at size %s without expansion", async (size) => {
    const snapshot = createWorkerSnapshot(collapsedElements(size));
    const encoded = serializeInkbookDocument(snapshot);

    expect(encoded, JSON.stringify(encoded)).toMatchObject({ ok: true });
    if (!encoded.ok) return;
    expect(await parseInkbookDocumentForTest(encoded.value.svg)).toMatchObject({
      ok: true,
      value: { snapshot },
    });
  });
});
