import { expect, it } from "vitest";
import {
  encodeRuntimeSelection,
  resolveClipboardPayload,
} from "../../../../src/persistence/clipboard/codec";
import { planPaste } from "../../../../src/persistence/clipboard/operations";
import { capturePastePlan } from "../../../../src/persistence/clipboard/paste-plan-snapshot";
import { validateClipboardPayload } from "../../../../src/persistence/clipboard/validation";
import { validFontResource, page, RECTANGLE_ID, rectangle, textElement, arrow } from "./fixtures";
import { resolveShapeAnchor } from "../../../../src/domain/geometry/public";
import type { LineElementV1 } from "../../../../src/domain/schema/public";
import { parseTextMarkdown } from "../../../fixtures/domain/text-source";
import { layoutTextMarkdown } from "../../../../src/rendering/text/text-layout";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import {
  encodeRuntimeSelectionChunked,
  decodeClipboardChunked,
} from "../../../../src/persistence/worker/runtime/model/fallback-clipboard-codec";

it("binds copied synthesized bold to the source face across destination font additions", async () => {
  const regular = await validFontResource();
  const family = `custom-${regular.id}`;
  const sourceRegular = { ...regular, family };
  const destinationBold = { ...(await validFontResource(700)), family };
  const text = textElement("Bold");
  text.style.fontFamily = family;
  text.layout.lines[0]!.runs[0]!.style = { bold: true };
  const selectedIds = new Set([text.id]);
  const encoded = encodeRuntimeSelection([text], selectedIds, [sourceRegular]);
  if (!encoded.ok) throw new Error(encoded.error.message);
  const context = { checkpoint: () => undefined, signal: new AbortController().signal };
  const sliced = await encodeRuntimeSelectionChunked([text], [...selectedIds], context, [
    sourceRegular,
  ]);
  if (!sliced.ok) throw new Error(sliced.error.message);
  expect(sliced.value.customText).toBe(encoded.value.customText);
  expect(text.layout.lines[0]!.runs[0]!.fontResourceId).toBeUndefined();
  const decoded = await decodeClipboardChunked({ customText: sliced.value.customText }, context);
  if (!decoded.ok) throw new Error(decoded.error.message);
  const pasted = planPaste({
    decoded: decoded.value,
    existingElements: [],
    page: page(),
    target: { x: 400, y: 300 },
    commandTimestamp: 100,
    createId: () => RECTANGLE_ID,
  });
  if (!pasted.ok) throw new Error(pasted.error.message);
  const copy = pasted.value.elements[0]!;
  if (copy.kind !== "text") throw new Error("Expected a pasted text field.");
  expect(copy.id).not.toBe(text.id);
  expect(copy.layout.lines[0]!.runs[0]!.fontResourceId).toBe(sourceRegular.id);
  const destinationResources = [sourceRegular, destinationBold];
  const recopied = encodeRuntimeSelection([copy], new Set([copy.id]), destinationResources);
  if (!recopied.ok) throw new Error(recopied.error.message);
  expect(recopied.value.payload.fontResources?.map(({ id }) => id)).toEqual([sourceRegular.id]);
  const body = recopied.value.payload.elements[0]!.element;
  if (body.kind !== "text") throw new Error("Expected copied text.");
  expect(body.layout.lines[0]!.runs[0]!.fontResourceId).toBe(sourceRegular.id);
  const newlyResolved = encodeRuntimeSelection([text], selectedIds, destinationResources);
  if (!newlyResolved.ok) throw new Error(newlyResolved.error.message);
  expect(newlyResolved.value.payload.fontResources?.map(({ id }) => id)).toEqual([
    destinationBold.id,
  ]);
});

it("copies only rendered bold Markdown faces and retains the base face for empty fields", async () => {
  const text = textElement("**bold**");
  const document = parseTextMarkdown(text.source, { style: text.style });
  const rendered = await layoutTextMarkdown(
    { document, width: text.width, style: text.style },
    {
      measure: {
        measure: (source, style) => ({
          width: source.length * style.fontSize * 0.5,
          ascent: style.fontSize * 0.8,
          descent: style.fontSize * 0.2,
        }),
      },
      scheduler: createTestWorkScheduler(),
    },
  );
  text.layout = rendered.layout;
  text.height = rendered.height;
  text.pivot.y = text.height / 2;
  expect(text.layout.lines.flatMap((line) => line.runs)).toMatchObject([
    { text: "bold", start: 2, end: 6, style: { bold: true } },
  ]);
  const regular = await validFontResource();
  const bold = await validFontResource(700);
  const encoded = encodeRuntimeSelection([text], new Set([text.id]), [regular, bold]);
  if (!encoded.ok) throw new Error(encoded.error.message);
  expect(encoded.value.payload.fontResources?.map(({ id }) => id)).toEqual([bold.id]);
  expect(encoded.value.payload.elements[0]!.element).toMatchObject({
    source: "**bold**",
    style: { bold: false },
  });
  const empty = textElement("");
  empty.layout.lines[0]!.runs[0]!.style = { bold: true };
  const emptyEncoded = encodeRuntimeSelection([empty], new Set([empty.id]), [regular, bold]);
  if (!emptyEncoded.ok) throw new Error(emptyEncoded.error.message);
  expect(emptyEncoded.value.payload.fontResources?.map(({ id }) => id)).toEqual([regular.id]);
});

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

it("copies required effective font faces and propagates them through atomic paste planning", async () => {
  const text = textElement();
  text.ranges = [
    { start: 0, end: 4, style: { bold: true } },
    { start: 2, end: 4, style: { italic: true } },
  ];
  text.layout.lines[0]!.runs = [
    { text: "Te", start: 0, end: 2, x: 0, width: 20, style: { bold: true } },
    { text: "xt", start: 2, end: 4, x: 20, width: 20, style: { bold: true, italic: true } },
  ];
  const needed = await Promise.all([validFontResource(700), validFontResource(700, "italic")]);
  const encoded = encodeRuntimeSelection([text], new Set([text.id]), [
    ...needed,
    await validFontResource(),
    await validFontResource(400, "italic"),
  ]);
  expect(encoded.ok).toBe(true);
  if (!encoded.ok) throw new Error(encoded.error.message);
  expect(encoded.value.payload).toMatchObject({ version: 2, fontResources: needed });
  const decoded = resolveClipboardPayload({ customText: encoded.value.customText });
  if (!decoded.ok) throw new Error(decoded.error.message);
  const result = planPaste({
    decoded: decoded.value,
    existingElements: [],
    page: page(),
    commandTimestamp: 100,
    createId: () => RECTANGLE_ID,
    target: { x: 50, y: 15 },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  const captured = capturePastePlan(result.value)!;
  expect(captured.fontResources).toEqual(needed);
  expect(captured.elements[0]).toMatchObject({ id: RECTANGLE_ID, createdAt: 100, source: "Text" });
  expect(Object.isFrozen(captured.fontResources)).toBe(true);
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
