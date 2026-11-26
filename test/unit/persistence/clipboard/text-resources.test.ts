import { expect, it } from "vitest";
import {
  encodeRuntimeSelection,
  resolveClipboardPayload,
} from "../../../../src/persistence/clipboard/codec";
import { planPaste } from "../../../../src/persistence/clipboard/operations";
import { validateClipboardPayload } from "../../../../src/persistence/clipboard/validation";
import { validFontResource, page, RECTANGLE_ID, rectangle, textElement, arrow } from "./fixtures";
import { resolveShapeAnchor } from "../../../../src/domain/geometry/public";
import type { LineElementV1 } from "../../../../src/domain/schema/public";

it("roundtrips text box anchors and remaps connected line and arrow targets during paste", async () => {
  const text = textElement();
  const connectedArrow = { ...arrow(text.id), start: { x: 0, y: 0 }, pivot: { x: 20, y: 20 } };
  const line: LineElementV1 = {
    ...connectedArrow,
    kind: "line",
    id: RECTANGLE_ID,
    start: { x: 100, y: 15 },
    end: { x: 140, y: 55 },
    pivot: { x: 120, y: 35 },
    endNode: "none",
    startNode: "none",
    startConnection: { targetId: text.id, anchor: { kind: "box", position: "middle-right" } },
  };
  const originals = [text, line, connectedArrow];
  const fonts = [await validFontResource()];
  const encoded = encodeRuntimeSelection(originals, new Set(originals.map(({ id }) => id)), fonts);
  if (!encoded.ok) throw new Error(encoded.error.message);
  const decoded = resolveClipboardPayload({ customText: encoded.value.customText });
  if (!decoded.ok) throw new Error(decoded.error.message);
  const ids = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  ];
  let nextId = 0;
  const pasted = planPaste({
    decoded: decoded.value,
    existingElements: originals,
    page: page(),
    target: { x: 400, y: 300 },
    commandTimestamp: 100,
    createId: () => ids[nextId++]!,
  });
  if (!pasted.ok) throw new Error(pasted.error.message);
  expect(pasted.value.selectedIds).toEqual(ids);
  expect(pasted.value.fontResources).toEqual(fonts);
  const pastedText = pasted.value.elements[0]!;
  if (pastedText.kind !== "text") throw new Error("Expected pasted text.");
  expect(pastedText.source).toBe(text.source);
  for (const dependent of pasted.value.elements.slice(1)) {
    if (dependent.kind !== "line" && dependent.kind !== "arrow")
      throw new Error("Expected a connected linear element.");
    expect(dependent.startConnection?.targetId).toBe(pastedText.id);
    expect(dependent.startConnection?.targetId).not.toBe(text.id);
    expect(dependent.start).toEqual(
      resolveShapeAnchor(pastedText, dependent.startConnection!.anchor),
    );
    expect(dependent.createdAt).toBe(100);
  }
});

it("rejects missing font faces and legacy text while preserving legacy selection bytes", async () => {
  const text = textElement();
  const font = await validFontResource();
  expect(encodeRuntimeSelection([text], new Set([text.id])).ok).toBe(false);
  const encoded = encodeRuntimeSelection([text], new Set([text.id]), [font]);
  if (!encoded.ok) throw new Error(encoded.error.message);
  const payload = encoded.value.payload;
  expect(validateClipboardPayload({ ...payload, version: 1 }).ok).toBe(false);
  expect(validateClipboardPayload({ ...payload, fontResources: [] }).ok).toBe(false);
  expect(
    validateClipboardPayload({ ...payload, fontResources: [{ ...font, id: "0".repeat(64) }] }).ok,
  ).toBe(false);
  expect(
    validateClipboardPayload({ ...payload, fontResources: [{ ...font, data: "bad!" }] }).ok,
  ).toBe(false);
  const element = rectangle();
  expect(encodeRuntimeSelection([element], new Set([element.id]), [font])).toEqual(
    encodeRuntimeSelection([element], new Set([element.id])),
  );
});
