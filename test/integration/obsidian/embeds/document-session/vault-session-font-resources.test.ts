import { expect, it, vi } from "vitest";
import { loadBuiltinFont } from "../../../../../src/persistence/fonts/builtin-fonts";
import { TestWorkScheduler } from "../../../../fixtures/persistence/work-scheduler";
import { parseInkbookDocumentForTest } from "../../../../fixtures/persistence/parse-document";
import { textElement } from "../../../../unit/persistence/clipboard/fixtures";
import {
  documentFromSnapshot,
  emptySnapshot,
  operation,
  persistenceHarness,
  rectangle,
} from "./vault-session-fixtures";

it("adds fonts without materializing elements and preserves them through coalesced save and copy", async () => {
  const font = await loadBuiltinFont("inter", 400, "normal", new TestWorkScheduler());
  const harness = persistenceHarness();
  try {
    expect((await harness.session.unlock(operation())).status).toBe("active");
    const model = harness.session.documentModel!;
    const materialize = vi.spyOn(model.store, "materializeSnapshot");
    await model.ensureFontResources!([font]);
    expect(materialize).not.toHaveBeenCalled();
    expect(model.revision).toBe(8);
    expect(model.formatVersion).toBe(2);
    expect(model.fontResources).toEqual([font]);
    await model.ensureFontResources!([font]);
    expect(model.revision).toBe(8);
    model.commitElement(textElement());
    expect((await harness.session.lockLatest(operation())).status).toBe("confirmed");
    const saved = await parseInkbookDocumentForTest(harness.content());
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.value.snapshot).toMatchObject({ version: 2, revision: 9, fontResources: [font] });
    const copied = await model.encodeClipboard(new Set([textElement().id]));
    expect(JSON.parse(copied!.customText)).toMatchObject({ fontResources: [font], version: 2 });
  } finally {
    harness.session.dispose();
  }
});

it("keeps loaded resources across element mutation and rejects conflicting resource identities atomically", async () => {
  const font = await loadBuiltinFont("inter", 400, "normal", new TestWorkScheduler());
  const harness = persistenceHarness({
    ...emptySnapshot(),
    version: 2,
    fontResources: [font],
    elements: [textElement()],
  });
  try {
    expect((await harness.session.unlock(operation())).status).toBe("active");
    const model = harness.session.documentModel!;
    const fonts = model.fontResources;
    await expect(model.ensureFontResources!([{ ...font, family: "other" }])).rejects.toThrow(
      "Conflicting font identity",
    );
    expect(model.fontResources).toBe(fonts);
    expect(model.revision).toBe(7);
    model.commitElement(rectangle());
    expect((await harness.session.lockLatest(operation())).status).toBe("confirmed");
    const saved = await parseInkbookDocumentForTest(harness.content());
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.value.snapshot.fontResources).toEqual([font]);
  } finally {
    harness.session.dispose();
  }
});

it("adopts validated pasted font resources before callers commit pasted text", async () => {
  const font = await loadBuiltinFont("inter", 400, "normal", new TestWorkScheduler());
  const source = persistenceHarness({
    ...emptySnapshot(),
    version: 2,
    fontResources: [font],
    elements: [textElement()],
  });
  const target = persistenceHarness();
  try {
    await source.session.unlock(operation());
    await target.session.unlock(operation());
    const payload = await source.session.documentModel!.encodeClipboard(
      new Set([textElement().id]),
    );
    const model = target.session.documentModel!;
    const plan = await model.planClipboardPaste(
      { customText: payload!.customText },
      { kind: "toolbar", visibleCanvasCenter: { x: 150, y: 150 } },
    );
    expect(plan?.fontResources).toEqual([font]);
    expect(model.fontResources).toEqual([font]);
    expect(model.revision).toBe(8);
    model.commitElements(plan!.elements);
    expect((await target.session.lockLatest(operation())).status).toBe("confirmed");
  } finally {
    source.session.dispose();
    target.session.dispose();
  }
});

it("persists a registry-only revision while output omits unused resources", async () => {
  const font = await loadBuiltinFont("inter", 400, "normal", new TestWorkScheduler());
  const harness = persistenceHarness();
  try {
    await harness.session.unlock(operation());
    await harness.session.documentModel!.ensureFontResources!([font]);
    expect((await harness.session.lockLatest(operation())).status).toBe("confirmed");
    const saved = await parseInkbookDocumentForTest(harness.content());
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.value.snapshot.fontResources).toBeUndefined();
  } finally {
    harness.session.dispose();
  }
});

it("replaces the registry on external reload and includes the adopted fonts in recovery copies", async () => {
  const font = await loadBuiltinFont("inter", 400, "normal", new TestWorkScheduler());
  const harness = persistenceHarness();
  try {
    await harness.session.unlock(operation());
    harness.replaceExternal(
      documentFromSnapshot({
        ...emptySnapshot(),
        revision: 12,
        version: 2,
        fontResources: [font],
        elements: [textElement()],
      }),
    );
    expect(await harness.factory.notifyExternalChange("drawings/ink.svg", operation())).toBe(
      "reloaded",
    );
    const model = harness.session.documentModel!;
    expect(model.fontResources).toEqual([font]);
    model.commitElement(rectangle());
    expect(
      await harness.session.resolveRecovery("save-local-copy", {
        ...operation(),
        baseRevision: 13,
        operationId: 2,
      }),
    ).toMatchObject({ status: "confirmed" });
    const saved = [...harness.createdCopies.values()][0]!;
    const parsed = await parseInkbookDocumentForTest(saved.text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.snapshot.fontResources).toEqual([font]);
  } finally {
    harness.session.dispose();
  }
});
