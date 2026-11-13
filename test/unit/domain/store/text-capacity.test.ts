import { describe, expect, it } from "vitest";
import { DocumentCapacity } from "../../../../src/domain/store/records/document-capacity";
import { ElementStore } from "../../../../src/domain/store/public";
import { takeImmutableElementOwnership } from "../../../../src/domain/store/records/immutability";
import { calculateElementBounds } from "../../../../src/domain/geometry/bounds";
import type { TextElementV2 } from "../../../../src/domain/schema/public";
import { MAX_DOCUMENT_TEXT_BYTES } from "../../../../src/domain/schema/constants";
import { textElementPayloadBytes } from "../../../../src/domain/schema/text-payload-size";
import type { ElementRecord } from "../../../../src/domain/store/types";
import { validateInkSnapshotV1 } from "../../../../src/domain/schema/snapshot-validation";
import { snapshot, stroke, textElement, uuid } from "../schema/fixtures";

function largeText(): TextElementV2 {
  const text = textElement();
  text.source = "a".repeat(100_000);
  text.width = 1000;
  text.height = 20_000;
  text.pivot = { x: text.x + text.width / 2, y: text.y + text.height / 2 };
  text.layout.lines = Array.from({ length: 1000 }, (_, index) => ({
    x: 0,
    y: index * 20,
    width: 1000,
    height: 20,
    baseline: 15,
    runs: [
      { text: "a".repeat(100), start: index * 100, end: index * 100 + 100, x: 0, width: 1000 },
    ],
  }));
  return text;
}

function record(element: TextElementV2 | ReturnType<typeof stroke>): ElementRecord {
  return {
    element: takeImmutableElementOwnership(element),
    bounds: calculateElementBounds(element),
    geometryVersion: 0,
    paintVersion: 0,
  };
}

describe("aggregate text document capacity", () => {
  it("rejects a prepared edit over the aggregate limit and reuses released capacity", async () => {
    const text = largeText();
    const bytes = textElementPayloadBytes(text);
    const count = Math.floor(MAX_DOCUMENT_TEXT_BYTES / bytes);
    const elements = Array.from({ length: count }, (_, index) => ({
      ...text,
      id: uuid(index + 100),
    }));
    const store = new ElementStore(elements);
    const initial = store.get(elements[0]!.id)!.element;
    const rangeCount = Math.floor((MAX_DOCUMENT_TEXT_BYTES - count * bytes) / 256) + 1;
    const edited = {
      ...elements[0]!,
      ranges: Array.from({ length: rangeCount }, () => ({
        start: 0,
        end: 1,
        style: { bold: true },
      })),
    };
    const scheduler = { shouldYield: () => false, yieldControl: async () => undefined };
    await expect(store.prepareElementReplacement([edited], scheduler)).rejects.toThrow(
      "text-payload",
    );
    expect(store.get(initial.id)!.element).toBe(initial);
    store.remove([elements[elements.length - 1]!.id]);
    const prepared = await store.prepareElementReplacement([edited], scheduler);
    if (prepared.token === null) throw new Error("Expected admitted text replacement.");
    expect(store.commitPreparedElementReplacement(prepared.token).status).toBe("committed");
    store.remove(elements.map(({ id }) => id));
    expect(store.size).toBe(0);
    expect(() => store.create(elements)).not.toThrow();
  });

  it("keeps a mixed document bounded and releases capacity on deletion and smaller replacement", () => {
    const text = largeText();
    const bytes = textElementPayloadBytes(text);
    const count = Math.floor(MAX_DOCUMENT_TEXT_BYTES / bytes);
    const records = Array.from({ length: count }, (_, index) =>
      record({ ...text, id: uuid(index + 100) }),
    );
    const capacity = new DocumentCapacity();
    capacity.addInitial(record(stroke()));
    for (const value of records) capacity.addInitial(value);
    const extra = record({ ...text, id: uuid(999) });
    expect(() => capacity.prepare([], [extra])).toThrow("text-payload");
    capacity.commit(capacity.prepare([records[0]!], []));
    const small = record({ ...textElement(), id: records[1]!.element.id });
    capacity.commit(capacity.prepare([records[1]!], [small]));
    capacity.commit(capacity.prepare([], [extra]));
    const replacement = record({ ...text, id: uuid(998) });
    capacity.commit(capacity.prepare([], [replacement]));
    expect(() => capacity.prepare([], [record({ ...text, id: uuid(997) })])).toThrow(
      "text-payload",
    );
  });

  it("applies the same aggregate limit while validating snapshots without changing stroke limits", () => {
    const text = largeText();
    const count = Math.floor(MAX_DOCUMENT_TEXT_BYTES / textElementPayloadBytes(text));
    const elements = Array.from({ length: count + 1 }, (_, index) => ({
      ...text,
      id: uuid(index + 100),
    }));
    expect(
      validateInkSnapshotV1({ ...snapshot([stroke(), ...elements.slice(0, count)]), version: 2 })
        .ok,
    ).toBe(true);
    expect(
      validateInkSnapshotV1({ ...snapshot([stroke(), ...elements]), version: 2 }),
    ).toMatchObject({ ok: false, error: { code: "invalid-range" } });
  });
});
