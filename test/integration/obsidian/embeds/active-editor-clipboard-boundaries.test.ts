import { describe, expect, it, vi } from "vitest";

import { CLIPBOARD_SCHEMA_LIMITS, type InkElementV1 } from "../../../../src/domain/schema/public";
import { ElementStore, type AppliedElementMutation } from "../../../../src/domain/store/public";
import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { createDragElement } from "../../../../src/editor/tools/public";
import type { PastePlan } from "../../../../src/persistence/clipboard/public";
import { INKBOOK_CLIPBOARD_WEB_MIME } from "../../../../src/persistence/clipboard/public";
import { MAX_CLIPBOARD_ITEMS } from "../../../../src/obsidian/embeds/active-editor/clipboard-reader";
import { ActiveEditorClipboardController } from "../../../../src/obsidian/embeds/active-editor/controller-clipboard";
import { ActiveEditorHistory } from "../../../../src/obsidian/embeds/active-editor/history";
import type { EditableDocumentModel } from "../../../../src/obsidian/embeds/vault-document-session";
import {
  createClipboardDocumentModel,
  createDeferredPreparation,
  createPreparedToken,
} from "./active-editor-clipboard-fixtures";

describe("active editor clipboard input boundaries", () => {
  it("rejects an oversized Blob before text materialization or fallback", async () => {
    const text = vi.fn(async () => "unreachable");
    const readText = vi.fn(async () => "must-not-fallback");
    const item = candidateItem(INKBOOK_CLIPBOARD_WEB_MIME, {
      size: CLIPBOARD_SCHEMA_LIMITS.totalInputBytes + 1,
      text,
    });
    const harness = createHarness(new ElementStore([rectangle()]), [item], readText);

    await expect(harness.controller.paste(toolbarPaste())).resolves.toMatchObject({
      kind: "unavailable",
      reason: "clipboard-read-failed",
    });
    expect(text).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
    expect(harness.plan).not.toHaveBeenCalled();
    expect(harness.prepare).not.toHaveBeenCalled();
    harness.controller.dispose();
  });

  it("inspects only the first Clipboard item", async () => {
    const ordinaryText = vi.fn(async () => "ordinary text");
    const laterInkbookText = vi.fn(async () => '{"format":"inkbook-elements"}');
    const items = [
      candidateItem("text/plain", { size: 13, text: ordinaryText }),
      candidateItem(INKBOOK_CLIPBOARD_WEB_MIME, { size: 29, text: laterInkbookText }),
    ];
    const harness = createHarness(
      new ElementStore([rectangle()]),
      items,
      vi.fn(async () => "must-not-fallback"),
    );

    await expect(harness.controller.paste(toolbarPaste())).resolves.toMatchObject({
      kind: "committed",
    });
    expect(ordinaryText).toHaveBeenCalledOnce();
    expect(laterInkbookText).not.toHaveBeenCalled();
    expect(harness.plan).toHaveBeenCalledWith(
      { plainText: "ordinary text" },
      toolbarPaste(),
      undefined,
    );
    harness.controller.dispose();
  });

  it("rechecks maintained per-target fanout immediately before atomic adoption", async () => {
    const target = rectangle();
    const existing = Array.from({ length: 511 }, (_, index) =>
      connectedLine(uuid(index + 10), target.id),
    );
    const store = new ElementStore([target, ...existing]);
    const pending = createDeferredPreparation();
    const plan = createPastePlan(connectedLine(uuid(800), target.id));
    const commit = vi.fn(() => appliedMutation());
    const prepare = vi.fn(() => pending.promise);
    const model = createModel(
      store,
      vi.fn(async () => plan),
      prepare,
      commit,
    );
    const controller = createController(
      model,
      clipboardWindow(
        [],
        vi.fn(async () => ""),
      ),
    );

    const paste = controller.paste(toolbarPaste());
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    store.create([connectedLine(uuid(801), target.id)]);
    pending.complete();

    await expect(paste).resolves.toMatchObject({ kind: "unavailable", reason: "stale-operation" });
    expect(commit).not.toHaveBeenCalled();
    controller.dispose();
  });
});

describe("active editor clipboard collection limits", () => {
  it("rejects too many clipboard items before requesting any MIME payload", async () => {
    const materialize = vi.fn(async () => "unreachable");
    const items = Array.from({ length: MAX_CLIPBOARD_ITEMS + 1 }, () =>
      candidateItem(INKBOOK_CLIPBOARD_WEB_MIME, { size: 0, text: materialize }),
    );
    const harness = createHarness(new ElementStore([rectangle()]), items, vi.fn());

    await expect(harness.controller.paste(toolbarPaste())).resolves.toMatchObject({
      kind: "unavailable",
      reason: "clipboard-read-failed",
    });
    expect(materialize).not.toHaveBeenCalled();
    expect(harness.plan).not.toHaveBeenCalled();
    harness.controller.dispose();
  });

  it("fails closed when Clipboard.read is unavailable without reading unbounded text", async () => {
    const readText = vi.fn(async () => "x".repeat(32 * 1024 * 1024));
    const harness = createHarness(new ElementStore([rectangle()]), [], readText, async () => {
      throw new TypeError("Clipboard.read is unavailable.");
    });

    await expect(harness.controller.paste(toolbarPaste())).resolves.toMatchObject({
      kind: "unavailable",
      reason: "clipboard-read-failed",
    });
    expect(readText).not.toHaveBeenCalled();
    expect(harness.plan).not.toHaveBeenCalled();
    harness.controller.dispose();
  });
});

describe("active editor native paste boundary", () => {
  it("claims unsupported Clipboard data and reports the shared invalid-payload result", () => {
    const harness = createHarness(new ElementStore([rectangle()]), [], vi.fn());

    expect(
      harness.controller.pasteFromClipboardData(
        { getData: () => "ordinary text", types: ["text/plain"] },
        shortcutPaste(),
      ),
    ).toBe(true);
    expect(harness.controller.canPaste).toBe(false);
    expect(harness.plan).not.toHaveBeenCalled();
    expect(harness.onResult).toHaveBeenCalledWith({
      action: "paste",
      kind: "unavailable",
      reason: "invalid-payload",
    });
  });

  it("passes the last valid pointer placement with supported synchronous data", async () => {
    const harness = createHarness(new ElementStore([rectangle()]), [], vi.fn());
    const invocation = shortcutPaste({ x: 40, y: 50 });
    const customText = '{"format":"inkbook-elements"}';

    expect(
      harness.controller.pasteFromClipboardData(
        { getData: () => customText, types: [INKBOOK_CLIPBOARD_WEB_MIME] },
        invocation,
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(harness.plan).toHaveBeenCalled());
    expect(harness.plan).toHaveBeenCalledWith({ customText }, invocation, undefined);
  });
});

function createHarness(
  store: ElementStore,
  items: readonly ClipboardItem[],
  readText: () => Promise<string>,
  read: () => Promise<readonly ClipboardItem[]> = async () => [...items],
) {
  const plan = vi.fn(async () => createPastePlan(rectangle(uuid(900))));
  const prepare = vi.fn(async () => ({
    status: "prepared" as const,
    token: createPreparedToken(),
  }));
  const commit = vi.fn(() => appliedMutation());
  const model = createModel(store, plan, prepare, commit);
  const onResult = vi.fn();
  return {
    commit,
    controller: createController(model, clipboardWindow(items, readText, read), onResult),
    onResult,
    plan,
    prepare,
  };
}

function createController(model: EditableDocumentModel, ownerWindow: Window, onResult = vi.fn()) {
  return new ActiveEditorClipboardController({
    currentSelection: () => new Set(),
    history: new ActiveEditorHistory(model),
    isPresentationAttached: () => true,
    model,
    onPendingChanged: vi.fn(),
    onResult,
    onSelectionChanged: vi.fn(),
    ownerWindow,
  });
}

function createModel(
  store: ElementStore,
  planClipboardPaste: EditableDocumentModel["planClipboardPaste"],
  prepareElementMutation: EditableDocumentModel["prepareElementMutation"],
  commitPreparedElementMutation: EditableDocumentModel["commitPreparedElementMutation"],
): EditableDocumentModel {
  return createClipboardDocumentModel({
    store,
    commitPreparedElementMutation,
    planClipboardPaste,
    prepareElementMutation,
  });
}

function appliedMutation(): AppliedElementMutation {
  return {
    forward: { bands: { content: [], highlight: [] } },
    payloadBytes: 1,
    reverse: { bands: { content: [], highlight: [] } },
  };
}

function toolbarPaste() {
  return { kind: "toolbar" as const, visibleCanvasCenter: { x: 0, y: 0 } };
}

function shortcutPaste(
  lastSessionPointer: { readonly x: number; readonly y: number } | null = null,
) {
  return {
    kind: "shortcut" as const,
    lastSessionPointer,
    visibleCanvasCenter: { x: 10, y: 20 },
  };
}

function createPastePlan(element: InkElementV1): PastePlan {
  return {
    activateTool: "select",
    commandTimestamp: 1,
    contentIds: [element.id],
    elements: [element],
    highlightIds: [],
    insertAtBandFront: true,
    repeatState: { fingerprint: "fixture", pasteCount: 1 },
    selectedIds: [element.id],
    translation: { x: 0, y: 0 },
  };
}

function rectangle(id = uuid(1)): InkElementV1 {
  return createDragElement({
    defaults: createBuiltInSettings().toolDefaults,
    end: { x: 200, y: 200 },
    identity: { createdAt: 1, id },
    start: { x: 100, y: 100 },
    tool: "rectangle",
  });
}

function connectedLine(id: string, targetId: string): InkElementV1 {
  const line = createDragElement({
    defaults: createBuiltInSettings().toolDefaults,
    end: { x: 300, y: 150 },
    identity: { createdAt: 1, id },
    start: { x: 200, y: 150 },
    tool: "line",
  });
  if (line.kind !== "line") throw new Error("Expected a line fixture.");
  return {
    ...line,
    startConnection: {
      anchor: { kind: "box", position: "middle-right" },
      targetId,
    },
  };
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function candidateItem(mime: string, blob: Pick<Blob, "size" | "text">): ClipboardItem {
  return {
    getType: async (requested: string) => {
      if (requested !== mime) throw new TypeError("Unexpected MIME type.");
      return blob as Blob;
    },
    types: [mime],
  } as unknown as ClipboardItem;
}

function clipboardWindow(
  items: readonly ClipboardItem[],
  readText: () => Promise<string>,
  read: () => Promise<readonly ClipboardItem[]> = async () => [...items],
): Window {
  return {
    navigator: {
      clipboard: {
        read,
        readText,
        write: async () => undefined,
        writeText: async () => undefined,
      },
    },
  } as unknown as Window;
}
