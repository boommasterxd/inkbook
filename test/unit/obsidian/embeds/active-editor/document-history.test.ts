import { describe, expect, it, vi } from "vitest";

import { ElementStore } from "../../../../../src/domain/store/public";
import {
  ActiveDocumentHistory,
  PaneDocumentHistoryAdapter,
  UNIFIED_HISTORY_LOCK_NOTICE,
} from "../../../../../src/obsidian/embeds/active-editor/document-history";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import type { EditableDocumentModel } from "../../../../../src/obsidian/embeds/document-session/document-model-port";
import { elementMutationPorts } from "../../../../fixtures/obsidian/element-mutation-ports";
import { connectedLine, rectangle } from "../../../domain/store/fixtures";

async function expectCanvasStep(
  adapter: PaneDocumentHistoryAdapter,
  direction: "redo" | "undo",
  status: "applied" | "failed",
): Promise<void> {
  const result = adapter.handleShortcut(direction, false);
  if (result.status !== "canvas") throw new Error("Expected a Canvas history step.");
  await expect(result.completion).resolves.toEqual({ source: "canvas", status });
}

describe("active document element history", () => {
  it("restores removed targets and their connections after presentation disposal", async () => {
    const target = rectangle();
    const line = connectedLine(target);
    const store = new ElementStore([target, line]);
    const deltas = vi.fn();
    store.subscribe(deltas);
    let revision = 0;
    const mutations = elementMutationPorts(store, () => {
      revision += 1;
    });
    const model = {
      get revision() {
        return revision;
      },
      store,
      ...mutations,
    } as unknown as EditableDocumentModel;
    const prepare = model.prepareElementMutation.bind(model);
    const preparedCalls = vi.spyOn(model, "prepareElementMutation");
    const removalCalls = vi.spyOn(model, "prepareElementRemoval");
    const history = new ActiveEditorHistory(model);
    const documentHistory = new ActiveDocumentHistory({ history, model });

    await expect(documentHistory.remove([target.id])).resolves.toBe("applied");
    expect(store.get(target.id)).toBeUndefined();
    expect(store.get(line.id)?.element).toMatchObject({ startConnection: null });
    expect(deltas).toHaveBeenCalledTimes(1);
    expect(history.commandCount).toBe(1);
    documentHistory.dispose();

    await expect(history.undoAsync()).resolves.toBe(true);
    expect(store.get(target.id)?.element).toEqual(target);
    expect(store.get(line.id)?.element).toMatchObject({
      startConnection: { targetId: target.id },
    });
    expect(deltas).toHaveBeenCalledTimes(2);

    await expect(history.redoAsync()).resolves.toBe(true);
    expect(store.get(target.id)).toBeUndefined();
    expect(store.get(line.id)?.element).toMatchObject({ startConnection: null });
    expect(deltas).toHaveBeenCalledTimes(3);
    expect(removalCalls).toHaveBeenCalledOnce();
    const replay = preparedCalls.mock.calls[0]![1].replay;
    expect(replay).toBeDefined();
    expect(preparedCalls.mock.calls[0]![0]).toBe(replay!.reverse);
    expect(preparedCalls.mock.calls[1]![0]).toBe(replay!.forward);
    expect(preparedCalls.mock.calls[1]![1].replay).toBe(replay);

    let completePreparation = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      completePreparation = resolve;
    });
    preparedCalls.mockImplementation(async (...args) => {
      const prepared = await prepare(...args);
      await gate;
      return prepared;
    });
    const undoAtShutdown = history.undoAsync();
    await vi.waitFor(() => expect(preparedCalls).toHaveBeenCalledTimes(3));
    history.dispose();
    completePreparation();
    await expect(undoAtShutdown).resolves.toBe(false);
    expect(store.get(target.id)).toBeUndefined();
    expect(deltas).toHaveBeenCalledTimes(3);
  });

  it("rejects a prepared deletion after its selection becomes stale", async () => {
    const target = rectangle();
    const store = new ElementStore([target]);
    let current = true;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = {
      revision: 0,
      store,
      commitPreparedElementMutation: vi.fn(),
      prepareElementRemoval: async () => {
        await gate;
        return { status: "cancelled" as const, token: null };
      },
    } as unknown as EditableDocumentModel;
    const history = new ActiveEditorHistory(model);
    const documentHistory = new ActiveDocumentHistory({ history, model });

    const removal = documentHistory.remove([target.id], () => current);
    current = false;
    release();

    await expect(removal).resolves.toBe("stale");
    expect(store.get(target.id)).toBeDefined();
    expect(history.commandCount).toBe(0);
  });
});

describe("pane-scoped unified document history", () => {
  it("combines Canvas steps with native Markdown pass-through chronologically", async () => {
    const canvas = { redo: vi.fn(async () => true), undo: vi.fn(async () => true) };
    const adapter = new PaneDocumentHistoryAdapter(canvas);
    adapter.record("markdown");
    adapter.record("canvas");
    adapter.record("markdown");

    expect(adapter.handleShortcut("undo", false)).toEqual({
      source: "markdown",
      status: "pass-through",
    });
    await expectCanvasStep(adapter, "undo", "applied");
    expect(adapter.handleShortcut("undo", false)).toEqual({
      source: "markdown",
      status: "pass-through",
    });
    expect(adapter.handleShortcut("undo", false)).toEqual({
      message: UNIFIED_HISTORY_LOCK_NOTICE,
      status: "lock-notice",
    });
    expect(UNIFIED_HISTORY_LOCK_NOTICE).toContain("must be locked");
    expect(canvas.undo).toHaveBeenCalledOnce();

    expect(adapter.handleShortcut("redo", false)).toEqual({
      source: "markdown",
      status: "pass-through",
    });
    await expectCanvasStep(adapter, "redo", "applied");
    expect(adapter.handleShortcut("redo", false)).toEqual({
      source: "markdown",
      status: "pass-through",
    });
    expect(canvas.redo).toHaveBeenCalledOnce();
  });

  it("passes through while locked without consuming the next Canvas step", async () => {
    const canvas = { redo: vi.fn(async () => true), undo: vi.fn(async () => true) };
    const adapter = new PaneDocumentHistoryAdapter(canvas);
    adapter.record("canvas");

    expect(adapter.handleShortcut("undo", true)).toEqual({
      source: "locked",
      status: "pass-through",
    });
    expect(canvas.undo).not.toHaveBeenCalled();
    await expectCanvasStep(adapter, "undo", "applied");
  });

  it("restores the unified cursor when Canvas traversal fails", async () => {
    const canvas = {
      redo: vi.fn(async () => true),
      undo: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
    };
    const adapter = new PaneDocumentHistoryAdapter(canvas);
    adapter.record("canvas");

    await expectCanvasStep(adapter, "undo", "failed");
    await expectCanvasStep(adapter, "undo", "applied");
  });
});

describe("native Markdown history marker suppression", () => {
  it("suppresses exactly the marker caused by a pass-through Undo", async () => {
    const canvas = { redo: vi.fn(async () => true), undo: vi.fn(async () => true) };
    const adapter = new PaneDocumentHistoryAdapter(canvas);
    expect(adapter.record("markdown")).toBe(true);
    expect(adapter.handleShortcut("undo", false)).toEqual({
      source: "markdown",
      status: "pass-through",
    });
    expect(adapter.record("markdown")).toBe(false);
    expect(adapter.record("markdown")).toBe(true);

    expect(adapter.handleShortcut("undo", false)).toEqual({
      source: "markdown",
      status: "pass-through",
    });
    await Promise.resolve();
    expect(adapter.record("markdown")).toBe(true);
  });
});
