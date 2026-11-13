import { describe, expect, it, vi } from "vitest";

import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import type { WorkScheduler } from "../../../../../src/domain/scheduling/work-scheduler";
import { SharedFrameScheduler } from "../../../../../src/domain/scheduling/shared-frame-scheduler";
import { ElementStore } from "../../../../../src/domain/store/public";
import { CLIPBOARD_LIMITS } from "../../../../../src/persistence/clipboard/constants";
import { ActiveEditorActions } from "../../../../../src/obsidian/embeds/active-editor/controller-actions";
import { ActiveEditorClipboardController } from "../../../../../src/obsidian/embeds/active-editor/controller-clipboard";
import { TEXT_COPY_WRITE_TIMEOUT_MS } from "../../../../../src/obsidian/embeds/active-editor/clipboard-text-copy";
import * as textCopy from "../../../../../src/obsidian/embeds/active-editor/clipboard-text-copy";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { elementMutationPorts } from "../../../../fixtures/obsidian/element-mutation-ports";
import {
  immediateWorkScheduler,
  pausedWorkScheduler,
} from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { singleLineTextElement, textElement } from "../../../../fixtures/rendering/text";
import { ManualHost } from "../../../../fixtures/scheduling/manual-frame-host";
import {
  ClipboardItemFixture,
  createClipboardDocumentModel,
  createEncodedClipboardFixture,
  selectedRectangle,
} from "./active-editor-clipboard-fixtures";

describe("active editor text Copy actions", () => {
  it("defaults to full elements, supports either explicit format and updates the live preference", async () => {
    const source = "## Exact source\n\n$\\frac{a}{b}$\n**Text** & ä";
    const harness = textCopyHarness([singleLineTextElement(source)]);
    try {
      expect(harness.actions.canCopyText).toBe(true);
      await harness.execute("copy");
      expect(await harness.writtenText()).toBe(harness.encoded.plainText);
      expect(harness.encodeClipboard).toHaveBeenCalledOnce();

      await harness.execute("copy-text");
      expect(await harness.writtenText()).toBe(source);
      expect(harness.encodeClipboard).toHaveBeenCalledOnce();

      harness.actions.updateTextCopyPreference(true);
      expect(harness.actions.canCopyText).toBe(true);
      await harness.execute("copy");
      expect(await harness.writtenText()).toBe(source);
      await harness.execute("copy-element");
      expect(await harness.writtenText()).toBe(harness.encoded.plainText);
      expect(harness.encodeClipboard).toHaveBeenCalledTimes(2);
    } finally {
      harness.dispose();
    }
  });

  it("copies multiple text sources in render order and keeps mixed selections and Cut as full elements", async () => {
    const first = { ...singleLineTextElement("first"), id: id(2) };
    const second = { ...singleLineTextElement("second\n$\\alpha$"), id: id(3) };
    const harness = textCopyHarness([first, second, selectedRectangle()], { preference: true });
    try {
      harness.select([second.id, first.id]);
      await harness.execute("copy");
      expect(await harness.writtenText()).toBe("first\n\nsecond\n$\\alpha$");
      expect(harness.encodeClipboard).not.toHaveBeenCalled();
      expect(harness.lastItem()?.types).toEqual(["text/plain"]);

      harness.select([first.id, selectedRectangle().id]);
      expect(harness.actions.canCopyText).toBe(false);
      expect(harness.actions.isAvailable("copy-text")).toBe(false);
      await harness.execute("copy");
      expect(await harness.writtenText()).toBe(harness.encoded.plainText);
      harness.select([second.id]);
      await harness.execute("cut");
      expect(await harness.writtenText()).toBe(harness.encoded.plainText);
      expect(harness.store.get(second.id)).toBeUndefined();
      expect(harness.history.commandCount).toBe(1);
    } finally {
      harness.dispose();
    }
  });

  it("accepts a false preference and suppresses alternate actions for empty or shape-only selections", async () => {
    const harness = textCopyHarness([textElement({ id: id(2) }), selectedRectangle()], {
      preference: false,
    });
    try {
      harness.select([id(2)]);
      await harness.execute("copy");
      expect(await harness.writtenText()).toBe(harness.encoded.plainText);
      for (const selection of [[], [selectedRectangle().id]]) {
        harness.select(selection);
        expect(harness.actions.canCopyText).toBe(false);
        expect(harness.actions.isAvailable("copy-text")).toBe(false);
        expect(harness.actions.isAvailable("copy-element")).toBe(false);
      }
    } finally {
      harness.dispose();
    }
  });
});

describe("plain text clipboard ownership", () => {
  it("waits for the native write before success and replaces old internal JSON with source-only fallback", async () => {
    const source = "**Ordinary Markdown**";
    const harness = textCopyHarness([singleLineTextElement(source)]);
    try {
      await harness.controller.copy(harness.selection());
      let completeWrite: (() => void) | undefined;
      harness.write.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            completeWrite = resolve;
          }),
      );
      harness.onResult.mockClear();
      const pending = harness.controller.copyText(harness.selection());
      expect(harness.write).toHaveBeenCalledTimes(2);
      expect(harness.controller.pending).toBe(true);
      expect(harness.controller.canCopyOrCut).toBe(false);
      expect(harness.onResult).not.toHaveBeenCalled();
      expect(harness.controller.hasPastePayload).toBe(false);
      await expect(harness.controller.copy(harness.selection())).resolves.toMatchObject({
        kind: "unavailable",
        reason: "busy",
      });
      completeWrite?.();
      await expect(pending).resolves.toEqual({ action: "copy", kind: "copied" });
      await harness.controller.paste(toolbarPaste());
      expect(harness.onPasteText).toHaveBeenCalledWith(source, toolbarPaste());
      expect(harness.planClipboardPaste).not.toHaveBeenCalled();
      expect(harness.encodeClipboard).toHaveBeenCalledOnce();
    } finally {
      harness.dispose();
    }
  });

  it("reports native-write failure without success or a stale JSON fallback", async () => {
    const harness = textCopyHarness([textElement()], { preference: true });
    try {
      await harness.controller.copy(harness.selection());
      harness.write.mockRejectedValueOnce(new Error("Clipboard permission denied."));
      harness.onResult.mockClear();
      await expect(harness.controller.copyText(harness.selection())).resolves.toEqual({
        action: "copy",
        kind: "unavailable",
        reason: "plain-system-write-failed",
      });
      expect(harness.onResult).toHaveBeenCalledOnce();
      harness.write.mockRejectedValueOnce(new Error("Clipboard permission denied."));
      await harness.execute("copy");
      expect(harness.actions.actionConfirmation).toBeNull();
      expect(harness.onFeedback).toHaveBeenCalledWith("clipboard-copy-failed");
      expect(harness.onFeedback).not.toHaveBeenCalledWith("clipboard-copy-fallback");
      expect(harness.controller.hasPastePayload).toBe(false);
      await expect(harness.controller.paste(toolbarPaste())).resolves.toMatchObject({
        kind: "unavailable",
        reason: "clipboard-read-failed",
      });
      expect(harness.planClipboardPaste).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });
});

describe("plain text clipboard lifecycle", () => {
  it("times out a hanging native write, releases busy state and ignores its late completion", async () => {
    vi.useFakeTimers();
    const host = new ManualHost();
    const scheduler = new SharedFrameScheduler(host);
    host.time = scheduler.deadline();
    const harness = textCopyHarness([textElement()], { scheduler });
    try {
      let completeWrite: (() => void) | undefined;
      harness.write.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            completeWrite = resolve;
          }),
      );
      const pending = harness.controller.copyText(harness.selection());
      expect(harness.controller.pending).toBe(true);
      expect(host.pendingFrames).toBe(1);
      await vi.advanceTimersByTimeAsync(TEXT_COPY_WRITE_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({
        action: "copy",
        kind: "unavailable",
        reason: "plain-system-write-failed",
      });
      expect(harness.controller.pending).toBe(false);
      expect(harness.controller.hasPastePayload).toBe(false);
      expect(host.pendingFrames).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      completeWrite?.();
      await Promise.resolve();
      expect(harness.onResult).toHaveBeenCalledOnce();
      expect(harness.onResult).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "copied" }),
      );
    } finally {
      harness.dispose();
      scheduler.dispose();
      expect(host.pendingTimers).toBe(0);
      vi.useRealTimers();
    }
  });

  it("rejects stale document work and detachment without retaining text or announcing success", async () => {
    const paused = pausedWorkScheduler();
    const harness = textCopyHarness([textElement()], { scheduler: paused.scheduler });
    try {
      const pending = harness.controller.copyText(harness.selection());
      harness.store.remove([textElement().id]);
      paused.resume();
      await expect(pending).resolves.toMatchObject({
        kind: "unavailable",
        reason: "stale-operation",
      });
      expect(harness.controller.hasPastePayload).toBe(false);
      expect(harness.onResult).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "copied" }),
      );
    } finally {
      paused.resume();
      harness.dispose();
    }
    const host = new ManualHost();
    const scheduler = new SharedFrameScheduler(host);
    host.time = scheduler.deadline();
    const detached = textCopyHarness([textElement()], { scheduler });
    try {
      detached.write.mockImplementationOnce(() => new Promise<void>(() => undefined));
      const pending = detached.controller.copyText(detached.selection());
      expect(host.pendingFrames).toBe(1);
      detached.controller.dispose();
      await expect(pending).resolves.toMatchObject({
        kind: "unavailable",
        reason: "stale-operation",
      });
      expect(detached.controller.pending).toBe(false);
      expect(host.pendingFrames).toBe(0);
      expect(detached.controller.hasPastePayload).toBe(false);
    } finally {
      detached.dispose();
      scheduler.dispose();
      expect(host.pendingTimers).toBe(0);
    }
  });
});

it("rejects a completed source result when disposal runs before controller adoption", async () => {
  const harness = textCopyHarness([textElement()]);
  const copy = vi.spyOn(textCopy, "copyTextSelection").mockImplementationOnce(async () => {
    void Promise.resolve().then(() => harness.controller.dispose());
    return { kind: "copied", source: textElement().source };
  });
  try {
    await expect(harness.controller.copyText(harness.selection())).resolves.toEqual({
      action: "copy",
      kind: "unavailable",
      reason: "stale-operation",
    });
    expect(harness.controller.hasPastePayload).toBe(false);
    expect(harness.onResult).toHaveBeenCalledOnce();
    expect(harness.onResult).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "copied" }));
  } finally {
    copy.mockRestore();
    harness.dispose();
  }
});

describe("plain text clipboard limits", () => {
  it("honors the exact UTF-8 byte limit including separators and rejects larger output before materialization", async () => {
    const fullSource = "ä".repeat(100_000);
    const remaining = (CLIPBOARD_LIMITS.totalInputBytes - 41 * 200_000 - 41 * 2) / 2;
    const elements = Array.from({ length: 42 }, (_, index) => ({
      ...singleLineTextElement(index < 41 ? fullSource : "ä".repeat(remaining)),
      id: id(index + 1),
    }));
    const harness = textCopyHarness(elements);
    try {
      await expect(harness.controller.copyText(harness.selection())).resolves.toMatchObject({
        kind: "copied",
      });
      expect(new TextEncoder().encode(await harness.writtenText()).byteLength).toBe(
        CLIPBOARD_LIMITS.totalInputBytes,
      );
      const last = elements[elements.length - 1]!;
      harness.store.replaceMany([{ ...singleLineTextElement(`${last.source}x`), id: last.id }]);
      await expect(harness.controller.copyText(harness.selection())).resolves.toMatchObject({
        kind: "unavailable",
        reason: "encode-failed",
      });
      expect(harness.controller.hasPastePayload).toBe(false);
      expect(harness.encodeClipboard).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });
});

function textCopyHarness(
  elements: readonly InkElementV1[],
  options: { readonly preference?: boolean; readonly scheduler?: WorkScheduler } = {},
) {
  const store = new ElementStore(elements);
  let selection: ReadonlySet<string> = new Set(elements.map(({ id }) => id));
  const encoded = createEncodedClipboardFixture();
  const encodeClipboard = vi.fn(async () => encoded);
  const planClipboardPaste = vi.fn(async () => null);
  const onPasteText = vi.fn(async () => true);
  const onResult = vi.fn();
  const onFeedback = vi.fn();
  const model = createClipboardDocumentModel({
    store,
    ...elementMutationPorts(store, () => undefined),
    encodeClipboard,
    planClipboardPaste,
  });
  const history = new ActiveEditorHistory(model);
  const { writes, write, ownerWindow } = textClipboardWindow();
  const controller = new ActiveEditorClipboardController({
    currentSelection: () => selection,
    history,
    isPresentationAttached: () => true,
    model,
    onPendingChanged: vi.fn(),
    onResult,
    onSelectionChanged: vi.fn(),
    onPasteText,
    ownerWindow,
    workScheduler: options.scheduler ?? immediateWorkScheduler(),
  });
  const sceneStore = new ElementSceneStore(store);
  let pending = false;
  const actions = new ActiveEditorActions({
    ...(options.preference === undefined ? {} : { copyTextFieldsAsText: options.preference }),
    currentSelection: () => selection,
    history,
    isAttached: () => true,
    isEnabled: () => true,
    model,
    onCopyEmbed: vi.fn(),
    onDeleteEmbed: vi.fn(),
    onFeedback,
    onPasteCommitted: vi.fn(),
    onPendingChanged: (value) => {
      pending = value;
    },
    onStateChanged: vi.fn(),
    ownerWindow,
    renderer: { setElementFade: vi.fn(), clearElementFade: vi.fn() },
    sceneStore,
    setSelection: (value) => {
      selection = value;
    },
    visibleCenter: () => ({ x: 0, y: 0 }),
    lastSessionPointer: () => null,
    workScheduler: options.scheduler ?? immediateWorkScheduler(),
    onPasteText,
  });
  return {
    actions,
    controller,
    encoded,
    encodeClipboard,
    history,
    model,
    onFeedback,
    onPasteText,
    onResult,
    planClipboardPaste,
    store,
    write,
    lastItem: () => writes[writes.length - 1]?.[0],
    writtenText: async () =>
      (await writes[writes.length - 1]?.[0]?.getType("text/plain"))?.text() ?? "",
    select: (ids: readonly string[]) => {
      selection = new Set(ids);
    },
    selection: () => selection,
    execute: async (action: Parameters<ActiveEditorActions["execute"]>[0]) => {
      actions.execute(action);
      await vi.waitFor(() => expect(pending).toBe(false));
    },
    dispose: () => {
      controller.dispose();
      actions.dispose();
      sceneStore.release();
    },
  };
}

function textClipboardWindow() {
  const writes: ClipboardItemFixture[][] = [];
  const write = vi.fn(async (items: ClipboardItemFixture[]) => {
    writes.push(items);
  });
  const ownerWindow = {
    Blob,
    ClipboardItem: ClipboardItemFixture,
    setTimeout: (callback: () => void, delay?: number) => globalThis.setTimeout(callback, delay),
    clearTimeout: (handle: number) => globalThis.clearTimeout(handle),
    navigator: {
      clipboard: {
        write,
        read: async () => {
          throw new Error("Read denied.");
        },
      },
    },
  } as unknown as Window;
  return { writes, write, ownerWindow };
}

function id(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

function toolbarPaste() {
  return { kind: "toolbar" as const, visibleCanvasCenter: { x: 0, y: 0 } };
}
