// @vitest-environment happy-dom
// Register the native text fixture's isolated layout adapter before controller imports.
import {
  activeTextLayout,
  mountActiveTextSession,
} from "../../../../fixtures/obsidian/active-text-session";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { Command } from "obsidian";
import { registerInkbookCommands } from "../../../../../src/obsidian/commands/command-registry";
import {
  createActiveEditorModel,
  createHarness,
} from "../../../../fixtures/obsidian/active-controller";

import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { openFirstTextWithKeyboard } from "../../../../fixtures/obsidian/selected-text-activation";

beforeAll(installObsidianDomHelpers);
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("flushes native text and releases its export hook before a keyboard command erases the document", async () => {
  const state = mountActiveTextSession();
  const confirmationSources: string[] = [];
  const confirmationHooks: boolean[] = [];
  const confirm = vi.fn(async () => {
    const element = state.model.store.get(state.element.id)?.element;
    if (element?.kind === "text") confirmationSources.push(element.source);
    confirmationHooks.push(state.hasExportPreparation());
    return true;
  });
  const model = Object.defineProperties(
    createActiveEditorModel(state.model.store),
    Object.getOwnPropertyDescriptors(state.model),
  );
  const feedback = vi.fn();
  const harness = createHarness(
    { model, confirmEraseAll: confirm, onFeedback: feedback },
    state.renderer,
  );
  let release = () => undefined as void;
  try {
    await openFirstTextWithKeyboard(harness, state.container);
    expect(state.hasExportPreparation()).toBe(true);
    const preparations = state.prepare.mock.calls.length;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.prepare.mockImplementationOnce(async (element) => {
      await gate;
      return activeTextLayout(element);
    });
    state.input().dispatch({ changes: { from: 5, insert: " latest" } });
    await vi.waitFor(() => expect(state.prepare).toHaveBeenCalledTimes(preparations + 1));
    const commands: Command[] = [];
    registerInkbookCommands(
      {
        addCommand: (command) => {
          commands.push(command);
          return command;
        },
      },
      {
        isAvailable: (action) => action === "lock" || harness.controller.isActionAvailable(action),
        execute: (action) =>
          action === "lock"
            ? harness.controller.handleToolbarAction("lock")
            : harness.controller.executeAction(action),
      },
      { canInsert: () => false, request: () => false },
    );
    const command = commands.find(({ id }) => id === "erase-all");
    expect(command?.checkCallback?.(false)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(state.model.store.get(state.element.id)).toBeDefined();
    release();
    await vi.waitFor(() => expect(state.model.store.size).toBe(0));
    expect(feedback).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirmationSources).toEqual(["Hello latest"]);
    expect(confirmationHooks).toEqual([false]);
    expect(state.container.querySelector(".cm-editor")).toBeNull();
    expect(state.operations()).toBe(0);
    await state.prepareExport();
  } finally {
    release();
    harness.dispose();
    state.session.dispose();
  }
});
