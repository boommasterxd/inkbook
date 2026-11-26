import { expect, it } from "vitest";
import { validateInkSnapshotV1 } from "../../../../src/domain/schema/public";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/document-codec";
import { validateSafeSvg } from "../../../../src/persistence/documents/safe-svg-validator";
import {
  packElements,
  unpackElementsSteps,
} from "../../../../src/persistence/worker/runtime/wire/element-wire-codec";
import { completeSerializationSteps } from "../../../../src/persistence/serialization/output/serialization-model-preparation";
import { imageElement } from "../../../fixtures/domain/images";
import { rasterResource } from "../../../fixtures/persistence/image-svg";
import { parseInkbookDocumentForTest } from "../../../fixtures/persistence/parse-document";
import { textElement } from "../../domain/schema/fixtures";
import { createAllElementSnapshot } from "./fixtures";
import { validFontResource } from "../clipboard/fixtures";

it("retains lock states for vector, text and image elements in compact saved documents and worker records", async () => {
  const resource = rasterResource();
  const image = {
    ...imageElement(),
    id: "00000000-0000-4000-8000-000000006000",
    assetId: resource.id,
    crop: { x: 0, y: 0, width: 1, height: 1 },
  };
  const font = await validFontResource();
  const text = textElement(8000);
  text.style.fontFamily = font.family;
  text.layout.lines[0]!.runs[0]!.inkBounds = { minX: 0, minY: -15, maxX: 40, maxY: 5 };
  const snapshot = createAllElementSnapshot();
  snapshot.elements = [image, ...snapshot.elements, text].map((element, index) => ({
    ...element,
    ...(element.kind === "text" || index % 2 === 0 ? { locked: true } : {}),
  }));
  snapshot.version = 5;
  snapshot.imageResources = [resource];
  snapshot.fontResources = [font];
  const validation = validateInkSnapshotV1(snapshot);
  expect(validation.ok, JSON.stringify(validation)).toBe(true);
  const output = serializeInkbookDocument(snapshot);
  if (!output.ok) throw new Error(JSON.stringify(output.error));
  expect(output.value.snapshot.version).toBe(5);
  expect(validateSafeSvg(output.value.svg)).toMatchObject({ version: 5 });
  const loaded = await parseInkbookDocumentForTest(output.value.svg);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
  expect(loaded.value.snapshot).toEqual(output.value.snapshot);
  const records = completeSerializationSteps(unpackElementsSteps(packElements(snapshot.elements)));
  expect(records.map(({ id, locked }) => ({ id, locked }))).toEqual(
    snapshot.elements.map(({ id, locked }) => ({ id, locked })),
  );
});
