import { expect, it } from "vitest";
import { fontCssFamily, fontResourceCssFamily } from "../../../../src/domain/text/font-family";
import { loadBuiltinFont } from "../../../../src/persistence/fonts/builtin-fonts";
import { IncrementalDocumentSerializer } from "../../../../src/persistence/serialization/output/incremental-document-serializer";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/document-codec";
import { textElement } from "../../domain/schema/fixtures";
import { createSnapshot, inlineFormulaLayout } from "./fixtures";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { parseInkbookDocumentForTest } from "../../../fixtures/persistence/parse-document";
import { rewriteDocumentMetadata } from "../../../fixtures/persistence/metadata-rewrite";
import { ChunkedInkbookInputParser } from "../../../../src/persistence/serialization/input/chunked-input-codec";
import { serializeFontStylesheet } from "../../../../src/persistence/serialization/output/text-fonts";

it("keeps existing synthetic bold bound while new text selects an imported real bold face", async () => {
  const scheduler = new TestWorkScheduler();
  const loaded = await Promise.all([
    loadBuiltinFont("inter", 400, "normal", scheduler),
    loadBuiltinFont("inter", 700, "normal", scheduler),
  ]);
  const family = `custom-${loaded[0].id}`;
  const [regular, bold] = loaded.map(({ license: _license, ...face }) => ({ ...face, family }));
  const old = textElement();
  old.source = "**bold**";
  old.style.fontFamily = family;
  old.layout.lines[0]!.runs = [
    { text: "bold", start: 2, end: 6, x: 0, width: 40, style: { bold: true } },
  ];
  const serializer = new IncrementalDocumentSerializer();
  expect(
    serializer.reset({ ...createSnapshot([old]), version: 2, fontResources: [regular!] }).ok,
  ).toBe(true);
  const boundBefore = serializer.currentSnapshot()!.elements[0]!;
  expect(boundBefore).toMatchObject({
    layout: { lines: [{ runs: [{ fontResourceId: regular!.id }] }] },
  });
  expect(
    serializer.applyDelta({
      baseModelRevision: 7,
      modelRevision: 8,
      fontResources: [regular!, bold!],
    }).ok,
  ).toBe(true);
  expect(serializer.currentSnapshot()!.elements[0]).toEqual(boundBefore);
  const added = { ...old, id: textElement(9).id, x: 300, pivot: { x: 350, y: 125 } };
  expect(
    serializer.applyDelta({
      baseModelRevision: 8,
      modelRevision: 9,
      changedElements: [added],
      orderChanges: { content: [old.id, added.id] },
    }).ok,
  ).toBe(true);
  const saved = serializer.serialize();
  expect(saved.ok).toBe(true);
  if (!saved.ok) return;
  expect(saved.value.snapshot.elements[0]).toEqual(boundBefore);
  expect(saved.value.snapshot.elements[1]).toMatchObject({
    layout: { lines: [{ runs: [{ fontResourceId: bold!.id }] }] },
  });
  for (const face of [regular!, bold!]) {
    expect(saved.value.svg.split(face.data)).toHaveLength(2);
    expect(saved.value.svg).toContain(`font-family="${fontResourceCssFamily(face.id)}"`);
  }
  expect(saved.value.svg).toContain(
    `font-family="${fontResourceCssFamily(regular!.id)}" font-size="16.5" font-weight="700"`,
  );
  const reopened = await parseInkbookDocumentForTest(saved.value.svg);
  expect(reopened).toMatchObject({ ok: true, value: { snapshot: saved.value.snapshot } });
  const missing = rewriteDocumentMetadata(
    saved.value.svg,
    (metadata) =>
      metadata.replaceAll(
        `"fontResourceId":"${regular!.id}"`,
        `"fontResourceId":"${"0".repeat(64)}"`,
      ),
    true,
  );
  expect(await parseInkbookDocumentForTest(missing)).toMatchObject({
    ok: false,
    error: { code: "snapshot-invalid" },
  });
});

it("validates legacy registry font order before binding runs and rewriting in glyph order", async () => {
  const scheduler = new TestWorkScheduler();
  const fonts = await Promise.all([
    loadBuiltinFont("inter", 400, "normal", scheduler),
    loadBuiltinFont("inter", 700, "normal", scheduler),
  ]);
  const [regular, bold] = fonts.map(({ license: _license, ...face }) => face);
  const element = textElement();
  element.style.fontFamily = "inter";
  element.source = "**bold** plain";
  element.layout.lines[0]!.runs = [
    { text: "bold", start: 2, end: 6, x: 0, width: 35, style: { bold: true } },
    { text: " plain", start: 8, end: 14, x: 35, width: 40 },
  ];
  const saved = serializeInkbookDocument({
    ...createSnapshot([element]),
    version: 2,
    fontResources: [regular!, bold!],
  });
  expect(saved.ok).toBe(true);
  if (!saved.ok) return;
  expect(saved.value.snapshot.fontResources?.map(({ weight }) => weight)).toEqual([700, 400]);
  const registryOrder = [regular!, bold!];
  const legacyStyles = `<style id="inkbook-fonts">${serializeFontStylesheet(registryOrder, true)}</style>`;
  let source = saved.value.svg.replace(
    /<style id="inkbook-fonts">[\s\S]*?<\/style>/u,
    legacyStyles,
  );
  for (const face of registryOrder)
    source = source.replaceAll(fontResourceCssFamily(face.id), fontCssFamily(face.family));
  const legacy = rewriteDocumentMetadata(
    source,
    (metadata) => {
      const unbound = metadata.replaceAll(
        /,"(?:baseFontResourceId|fontResourceId)":"[a-f0-9]{64}"/gu,
        "",
      );
      const root = JSON.parse(unbound) as { fontResources: { id: string }[] };
      root.fontResources.sort(
        (left, right) => Number(right.id === regular!.id) - Number(left.id === regular!.id),
      );
      return JSON.stringify(root);
    },
    true,
  );
  for (const staticValidation of ["canonical", "safe"] as const) {
    const adopted: string[] = [];
    const parser = new ChunkedInkbookInputParser({
      staticValidation,
      onValidatedSnapshot: (snapshot) => {
        const text = snapshot.elements[0];
        if (text?.kind === "text") adopted.push(text.layout.lines[0]!.runs[0]!.fontResourceId!);
      },
    });
    expect((await parser.write(new TextEncoder().encode(legacy))).ok).toBe(true);
    const reopened = await parser.finish();
    expect(adopted).toEqual([bold!.id]);
    expect(reopened).toMatchObject({
      ok: true,
      value: {
        requiresCanonicalRewrite: true,
        snapshot: { elements: saved.value.snapshot.elements, fontResources: registryOrder },
      },
    });
    if (reopened.ok)
      expect(serializeInkbookDocument(reopened.value.snapshot)).toMatchObject({
        ok: true,
        value: { svg: saved.value.svg },
      });
  }
});

it("retains the explicit formula strut face after family regrouping without consulting a library", async () => {
  const scheduler = new TestWorkScheduler();
  const loaded = await loadBuiltinFont("inter", 400, "normal", scheduler);
  const regroupedFamily = await loadBuiltinFont("inter", 700, "normal", scheduler);
  const { license: _license, ...regular } = loaded;
  regular.family = `custom-${regular.id}`;
  const element = textElement();
  element.source = "$x$";
  element.style.fontFamily = `custom-${regroupedFamily.id}`;
  element.style.bold = true;
  element.layout.baseFontResourceId = regular.id;
  element.layout.lines[0]!.runs = [];
  element.layout.math = inlineFormulaLayout();
  const saved = serializeInkbookDocument({
    ...createSnapshot([element]),
    version: 2,
    fontResources: [regular],
  });
  expect(saved.ok).toBe(true);
  if (!saved.ok) return;
  expect(saved.value.snapshot.fontResources).toEqual([regular]);
  expect(saved.value.svg.split(regular.data)).toHaveLength(2);
  expect(await parseInkbookDocumentForTest(saved.value.svg)).toMatchObject({
    ok: true,
    value: { snapshot: saved.value.snapshot },
  });
  expect(serializeInkbookDocument({ ...saved.value.snapshot, fontResources: [] })).toMatchObject({
    ok: false,
    error: { code: "snapshot-invalid" },
  });
});
