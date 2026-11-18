import { it, expect, vi } from "vitest";
import { CLIPBOARD_SCHEMA_LIMITS } from "../../../../../src/domain/schema/public";
import { ElementStore } from "../../../../../src/domain/store/public";
import { ActiveEditorClipboardController } from "../../../../../src/obsidian/embeds/active-editor/controller-clipboard";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { elementMutationPorts } from "../../../../fixtures/obsidian/element-mutation-ports";
import { createClipboardDocumentModel } from "./active-editor-clipboard-fixtures";
import { DocumentModelRuntime } from "../../../../../src/persistence/worker/runtime/model/document-model";
import { snapshot, stroke, uuid } from "../../../../unit/domain/schema/fixtures";

it("preserves an over-capacity Cut and pastes the largest valid stroke selection from the session", async () => {
  const elements = Array.from({ length: CLIPBOARD_SCHEMA_LIMITS.strokes + 1 }, (_, index) =>
    stroke(index + 1),
  );
  const remaining = elements[elements.length - 1]!;
  const runtime = new DocumentModelRuntime();
  runtime.initialize(snapshot(elements));
  const store = new ElementStore(elements);
  const context = { signal: new AbortController().signal, checkpoint: () => undefined };
  let nextId = elements.length + 1;
  const model = createClipboardDocumentModel({
    store,
    ...elementMutationPorts(store, () => undefined),
    encodeClipboard: async (ids) => {
      const encoded = await runtime.encodeClipboardSliced(0, [...ids], context);
      return encoded.ok ? encoded.value : null;
    },
    planClipboardPaste: async (candidates, invocation) => {
      const plan = await runtime.planClipboardPasteSliced(0, candidates, {
        commandTimestamp: 1,
        context,
        invocation,
        createId: () => uuid(nextId++),
      });
      return plan.ok ? plan.value : null;
    },
  });
  const all = new Set(elements.map(({ id }) => id));
  let selection: ReadonlySet<string> = new Set([remaining.id]);
  const history = new ActiveEditorHistory(model);
  const controller = new ActiveEditorClipboardController({
    currentSelection: () => selection,
    history,
    isPresentationAttached: () => true,
    model,
    onPendingChanged: vi.fn(),
    onResult: vi.fn(),
    onSelectionChanged: (next) => {
      selection = next;
    },
    ownerWindow: { navigator: {} } as Window,
    workScheduler: immediateWorkScheduler(),
  });
  const paste = () =>
    controller.paste({ kind: "toolbar", visibleCanvasCenter: { x: 110, y: 110 } });
  try {
    await expect(controller.copy(selection)).resolves.toMatchObject({ kind: "copied" });
    selection = all;
    const initial = store.mutationVersion;
    await expect(controller.cut(selection)).resolves.toMatchObject({
      kind: "unavailable",
      reason: "encode-failed",
    });
    expect(store.mutationVersion).toBe(initial);
    expect(selection.size).toBe(elements.length);
    expect(store.size).toBe(elements.length);
    expect(history.commandCount).toBe(0);
    await expect(paste()).resolves.toMatchObject({ kind: "committed" });
    expect(selection.size).toBe(1);
    expect(store.size).toBe(elements.length + 1);
    await expect(history.undoAsync()).resolves.toBe(true);

    selection = new Set([...all].filter((id) => id !== remaining.id));
    await expect(controller.cut(selection)).resolves.toMatchObject({ kind: "committed" });
    expect(store.materializeBandOrder("content")).toEqual([remaining.id]);
    expect(history.commandCount).toBe(1);
    runtime.initialize(snapshot([remaining]));
    await expect(paste()).resolves.toMatchObject({ kind: "committed" });
    expect(selection.size).toBe(CLIPBOARD_SCHEMA_LIMITS.strokes);
    expect(store.size).toBe(elements.length);
    expect(history.commandCount).toBe(2);
    const restored = store.get([...selection][0]!)!.element;
    expect(restored.kind === "stroke" && [...restored.points]).toEqual(elements[0]!.points);
  } finally {
    controller.dispose();
    runtime.clear();
  }
});
