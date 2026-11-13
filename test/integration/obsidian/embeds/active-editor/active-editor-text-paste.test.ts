import { expect, it, vi } from "vitest";
import { ElementStore } from "../../../../../src/domain/store/public";
import type { FontResourceV2 } from "../../../../../src/domain/schema/public";
import {
  INKBOOK_CLIPBOARD_TEXT_PREFIX,
  INKBOOK_CLIPBOARD_WEB_MIME,
} from "../../../../../src/persistence/clipboard/constants";
import { ActiveEditorClipboardController } from "../../../../../src/obsidian/embeds/active-editor/controller-clipboard";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { elementMutationPorts } from "../../../../fixtures/obsidian/element-mutation-ports";
import {
  createClipboardDocumentModel,
  createPastePlan,
  selectedRectangle,
} from "./active-editor-clipboard-fixtures";
import { textElement, validFontResource } from "../../../../unit/persistence/clipboard/fixtures";

const invocation = { kind: "toolbar" as const, visibleCanvasCenter: { x: 30, y: 40 } };

function harness(
  values: Record<string, string>,
  options: {
    plan?: ReturnType<typeof createPastePlan>;
    onPasteText?: (source: string) => Promise<boolean>;
  } = {},
) {
  const store = new ElementStore();
  let revision = 0;
  let fonts: readonly FontResourceV2[] = [];
  const plan = vi.fn(async () => options.plan ?? null);
  const model = createClipboardDocumentModel({
    store,
    revision: () => revision,
    ...elementMutationPorts(store, () => {
      revision += 1;
    }),
    planClipboardPaste: plan,
  });
  Object.defineProperty(model, "fontResources", { get: () => fonts });
  const item = {
    types: Object.keys(values),
    getType: async (mime: string) => new Blob([values[mime]!], { type: mime }),
  };
  const read = vi.fn(async () => [item]);
  const pasteText = vi.fn(options.onPasteText ?? (async () => true));
  const onResult = vi.fn();
  const onPasteCommitted = vi.fn();
  const onPendingChanged = vi.fn();
  const controller = new ActiveEditorClipboardController({
    model,
    history: new ActiveEditorHistory(model),
    currentSelection: () => new Set(),
    isPresentationAttached: () => true,
    onPendingChanged,
    onPasteText: pasteText,
    onPasteCommitted,
    onResult,
    onSelectionChanged: vi.fn(),
    ownerWindow: { navigator: { clipboard: { read } } } as unknown as Window,
    workScheduler: immediateWorkScheduler(),
  });
  return {
    controller,
    model,
    store,
    plan,
    pasteText,
    read,
    onResult,
    onPasteCommitted,
    onPendingChanged,
    addFonts: (resources: readonly FontResourceV2[]) => {
      fonts = resources;
      revision += 1;
    },
  };
}

it("prefers exact multiline Markdown and reports success only after text creation commits", async () => {
  let complete!: (result: boolean) => void;
  const pending = new Promise<boolean>((resolve) => {
    complete = resolve;
  });
  const source = "# Title\n\n**Text** and $x^2$\n";
  const current = harness(
    { "text/plain": "plain rendering", "text/markdown": source },
    { onPasteText: () => pending },
  );
  const result = current.controller.paste(invocation);
  await vi.waitFor(() => expect(current.pasteText).toHaveBeenCalledWith(source, invocation));
  expect(current.plan).not.toHaveBeenCalled();
  expect(current.onPasteCommitted).not.toHaveBeenCalled();
  expect(current.controller.pending).toBe(true);
  complete(true);
  await expect(result).resolves.toEqual({ action: "paste", kind: "committed" });
  expect(current.onPasteCommitted).toHaveBeenCalledExactlyOnceWith("select", invocation);
  expect(current.onPendingChanged.mock.calls).toEqual([[true], [false]]);
  current.controller.dispose();
});

it("accepts native synchronous plain text without changing line endings", async () => {
  const current = harness({});
  const source = "Line one\r\nLine two\n";
  expect(
    current.controller.pasteFromClipboardData(
      { types: ["text/plain"], getData: () => source },
      invocation,
    ),
  ).toBe(true);
  await vi.waitFor(() =>
    expect(current.onResult).toHaveBeenCalledWith({ action: "paste", kind: "committed" }),
  );
  expect(current.pasteText).toHaveBeenCalledExactlyOnceWith(source, invocation);
  expect(current.read).not.toHaveBeenCalled();
  current.controller.dispose();
});

async function expectInvalidPaste(current: ReturnType<typeof harness>): Promise<void> {
  await expect(current.controller.paste(invocation)).resolves.toMatchObject({
    kind: "unavailable",
    reason: "invalid-payload",
  });
  expect(current.pasteText).not.toHaveBeenCalled();
  current.controller.dispose();
}

it.each([
  { [INKBOOK_CLIPBOARD_WEB_MIME]: "", "text/plain": "ordinary" },
  { [INKBOOK_CLIPBOARD_WEB_MIME]: "{malformed", "text/markdown": "# ordinary" },
  { "text/plain": `${INKBOOK_CLIPBOARD_TEXT_PREFIX}{malformed`, "text/markdown": "# ordinary" },
])("rejects malformed claimed Inkbook data without converting it to text: %j", async (values) => {
  await expectInvalidPaste(harness(values));
});

it("keeps valid Inkbook elements ahead of accompanying ordinary text", async () => {
  const plan = createPastePlan(selectedRectangle());
  const current = harness(
    { [INKBOOK_CLIPBOARD_WEB_MIME]: "recognized", "text/markdown": "# ordinary" },
    { plan },
  );
  await expect(current.controller.paste(invocation)).resolves.toMatchObject({ kind: "committed" });
  expect(current.store.get(plan.selectedIds[0]!)?.element.kind).toBe("rectangle");
  expect(current.pasteText).not.toHaveBeenCalled();
  current.controller.dispose();
});

it.each([
  { name: "empty", source: "" },
  { name: "oversized", source: "x".repeat(100_001) },
  { name: "unsupported", source: "bad\u0000text" },
])("rejects $name ordinary text", async ({ source }) => {
  await expectInvalidPaste(harness({ "text/plain": source }));
});

it("rejects a changed document during clipboard reading before creating a field", async () => {
  const current = harness({ "text/plain": "Text" });
  current.read.mockImplementationOnce(async () => {
    current.store.create([selectedRectangle()]);
    return [];
  });
  await expect(current.controller.paste(invocation)).resolves.toMatchObject({
    kind: "unavailable",
    reason: "stale-operation",
  });
  expect(current.plan).not.toHaveBeenCalled();
  expect(current.pasteText).not.toHaveBeenCalled();
  current.controller.dispose();
});

it("accepts the source length boundary and keeps failed text creation available for retry", async () => {
  const current = harness({ "text/plain": "x".repeat(100_000) });
  current.pasteText.mockResolvedValueOnce(false);
  await expect(current.controller.paste(invocation)).resolves.toMatchObject({
    kind: "unavailable",
    reason: "paste-failed",
  });
  expect(current.controller.pending).toBe(false);
  expect(current.controller.canPaste).toBe(true);
  expect(current.onPasteCommitted).not.toHaveBeenCalled();
  await expect(current.controller.paste(invocation)).resolves.toMatchObject({ kind: "committed" });
  expect(current.pasteText).toHaveBeenCalledTimes(2);
  expect(current.pasteText.mock.calls[0]?.[0]).toHaveLength(100_000);
  current.controller.dispose();
});

it("accepts its own font revision and rejects a real document edit during that admission", async () => {
  const fontResources = [await validFontResource()];
  const plan = { ...createPastePlan(textElement()), fontResources };
  const current = harness({ [INKBOOK_CLIPBOARD_WEB_MIME]: "recognized" }, { plan });
  current.plan.mockImplementationOnce(async () => {
    current.addFonts(fontResources);
    return plan;
  });
  await expect(current.controller.paste(invocation)).resolves.toMatchObject({ kind: "committed" });
  expect(current.store.get(plan.selectedIds[0]!)?.element.kind).toBe("text");
  current.controller.dispose();

  const changed = harness({ [INKBOOK_CLIPBOARD_WEB_MIME]: "recognized" }, { plan });
  changed.plan.mockImplementationOnce(async () => {
    changed.addFonts(fontResources);
    changed.store.create([selectedRectangle()]);
    return plan;
  });
  await expect(changed.controller.paste(invocation)).resolves.toMatchObject({
    kind: "unavailable",
    reason: "stale-operation",
  });
  expect(changed.store.get(plan.selectedIds[0]!)).toBeUndefined();
  changed.controller.dispose();
});
