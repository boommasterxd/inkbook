import { expect, it } from "vitest";
import { validateInkSnapshotV1 } from "../../../../src/domain/schema/public";
import { elementSnapshotVersion } from "../../../../src/domain/schema/snapshot-version";
import { ElementStore } from "../../../../src/domain/store/public";
import { snapshot, stroke, textElement } from "./fixtures";

it("requires version five for measured glyph bounds while retaining older unmeasured text", () => {
  const text = textElement();
  const line = text.layout.lines[0]!;
  line.runs = [
    { text: "He", start: 0, end: 2, x: 0, width: 16 },
    {
      text: "llo",
      start: 2,
      end: 5,
      x: 16,
      width: 24,
      inkBounds: { minX: -2, minY: -14, maxX: 30, maxY: 4 },
    },
  ];
  expect(elementSnapshotVersion([{ ...stroke(), locked: true }, text])).toBe(5);
  const document = snapshot([text]);
  expect(validateInkSnapshotV1({ ...document, version: 5 }).ok).toBe(true);
  for (const version of [2, 3, 4])
    expect(validateInkSnapshotV1({ ...document, version }).ok).toBe(false);
  const store = new ElementStore([text]);
  expect(store.materializeSnapshot({ page: document.page, revision: 0 }).version).toBe(5);
  delete line.runs[1]!.inkBounds;
  expect(elementSnapshotVersion([text])).toBe(2);
  expect(validateInkSnapshotV1({ ...document, version: 2 }).ok).toBe(true);
});
