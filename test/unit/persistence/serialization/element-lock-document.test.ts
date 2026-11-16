import { expect, it } from "vitest";
import { validateInkSnapshotV1 } from "../../../../src/domain/schema/public";
import { elementSnapshotVersion } from "../../../../src/domain/schema/snapshot-version";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/document-codec";
import { IncrementalDocumentSerializer } from "../../../../src/persistence/serialization/output/incremental-document-serializer";
import { canonicalElement } from "../../../../src/persistence/serialization/metadata/canonical-snapshot";
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
import { createAllElementSnapshot, createSnapshot } from "./fixtures";
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

it("saves locked drawings without images and returns to the oldest compatible format after unlocking", async () => {
  const initial = createAllElementSnapshot();
  const serializer = new IncrementalDocumentSerializer();
  expect(serializer.reset(initial).ok).toBe(true);
  const locked = initial.elements.map((element) => ({ ...element, locked: true }));
  expect(
    serializer.applyDelta({ baseModelRevision: 7, modelRevision: 8, changedElements: locked }).ok,
  ).toBe(true);
  const output = await serializer.serializeChunked();
  if (!output.ok) throw new Error(JSON.stringify(output.error));
  expect(output.value.snapshot.version).toBe(4);
  const loaded = await parseInkbookDocumentForTest(output.value.svg);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
  expect(loaded.value.snapshot.elements.every((element) => element.locked === true)).toBe(true);
  expect(
    serializer.applyDelta({
      baseModelRevision: 8,
      modelRevision: 9,
      changedElements: locked.map((element) => ({ ...element, locked: false })),
    }).ok,
  ).toBe(true);
  const unlocked = serializer.serialize();
  if (!unlocked.ok) throw new Error(JSON.stringify(unlocked.error));
  expect(unlocked.value.snapshot.version).toBe(1);
  expect(
    unlocked.value.snapshot.elements.every(
      (element) => !Object.prototype.hasOwnProperty.call(element, "locked"),
    ),
  ).toBe(true);
  expect(validateSafeSvg(unlocked.value.svg)).toMatchObject({ version: 1 });
});

it("requires version four for stored locks and rejects malformed lock states", () => {
  const snapshot = createAllElementSnapshot();
  snapshot.version = 4;
  snapshot.elements.forEach((element) => {
    element.locked = true;
  });
  expect(validateInkSnapshotV1(snapshot).ok).toBe(true);
  for (const version of [1, 2, 3] as const)
    expect(validateInkSnapshotV1({ ...snapshot, version }).ok).toBe(false);
  const malformed = { ...snapshot, elements: [{ ...snapshot.elements[0], locked: "true" }] };
  expect(validateInkSnapshotV1(malformed).ok).toBe(false);
  const element = snapshot.elements[0]!;
  expect(
    Object.prototype.hasOwnProperty.call(canonicalElement({ ...element, locked: false }), "locked"),
  ).toBe(false);
  expect(elementSnapshotVersion(createSnapshot().elements)).toBe(1);
  expect(elementSnapshotVersion([textElement()])).toBe(2);
  expect(elementSnapshotVersion([imageElement()])).toBe(5);
  expect(elementSnapshotVersion([{ ...textElement(), locked: true }, imageElement()])).toBe(5);
  expect(elementSnapshotVersion([{ ...textElement(), locked: true }])).toBe(4);
});
