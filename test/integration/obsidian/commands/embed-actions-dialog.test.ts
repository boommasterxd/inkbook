import { afterEach, describe, expect, it, vi } from "vitest";

import * as dialogs from "../../../../src/obsidian/dialogs/action-dialog";
import { createHarness } from "./embed-actions-fixture";

const markdown = "!inkbook[[drawings/page.svg]]";
const target = "drawings/page.svg";

afterEach(() => vi.restoreAllMocks());

function deferredConfirmation() {
  let settle: (accepted: boolean) => void = () => {
    throw new Error("Confirmation is not pending.");
  };
  const promise = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

function expectUnchanged(harness: ReturnType<typeof createHarness>): void {
  expect(harness.editor.value()).toBe(markdown);
  expect(harness.process).not.toHaveBeenCalled();
  expect(harness.trashFile).not.toHaveBeenCalled();
}

describe("asynchronous embed deletion confirmations", () => {
  it("waits for both decisions before removing the embed or trashing its file", async () => {
    const harness = createHarness();
    const embed = deferredConfirmation();
    const file = deferredConfirmation();
    const prompt = vi
      .spyOn(dialogs, "confirmInkbookAction")
      .mockReturnValueOnce(embed.promise)
      .mockReturnValueOnce(file.promise);
    const result = harness.actions.deleteEmbed(target);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expectUnchanged(harness);
    embed.settle(true);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expectUnchanged(harness);
    file.settle(true);
    await expect(result).resolves.toEqual({ kind: "deleted", fileDeleted: true });
    expect(harness.editor.value()).toBe("");
    expect(harness.trashFile).toHaveBeenCalledOnce();
  });

  it("rejects a duplicate request while allowing a later request after cancellation", async () => {
    const harness = createHarness({ references: 2 });
    const pending = deferredConfirmation();
    const prompt = vi.spyOn(dialogs, "confirmInkbookAction").mockReturnValueOnce(pending.promise);
    const first = harness.actions.deleteEmbed(target);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    await expect(harness.actions.deleteEmbed(target)).resolves.toEqual({
      kind: "cancelled",
      stage: "embed",
    });
    expect(prompt).toHaveBeenCalledOnce();
    expectUnchanged(harness);
    pending.settle(false);
    await expect(first).resolves.toEqual({ kind: "cancelled", stage: "embed" });
    prompt.mockResolvedValueOnce(true);
    await expect(harness.actions.deleteEmbed(target)).resolves.toEqual({
      kind: "deleted",
      fileDeleted: false,
    });
  });

  it("aborts the open confirmation when its owner is disposed", async () => {
    const harness = createHarness();
    const pending = deferredConfirmation();
    const prompt = vi.spyOn(dialogs, "confirmInkbookAction").mockReturnValueOnce(pending.promise);
    const result = harness.actions.deleteEmbed(target);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    const signal = prompt.mock.calls[0]?.[1].signal;
    expect(signal?.aborted).toBe(false);
    harness.actions.dispose();
    expect(signal?.aborted).toBe(true);
    pending.settle(false);
    await expect(result).resolves.toEqual({ kind: "cancelled", stage: "embed" });
    expectUnchanged(harness);
    await expect(harness.actions.deleteEmbed(target)).resolves.toEqual({
      kind: "cancelled",
      stage: "embed",
    });
    expect(prompt).toHaveBeenCalledOnce();
  });
});

describe("pending embed deletion invalidation", () => {
  it.each(["editor", "vault"])(
    "rejects changed %s content while a decision is pending",
    async (source) => {
      const harness = createHarness({ references: 2, editorAvailable: source === "editor" });
      const pending = deferredConfirmation();
      const prompt = vi.spyOn(dialogs, "confirmInkbookAction").mockReturnValueOnce(pending.promise);
      const reference =
        source === "editor"
          ? target
          : {
              documentId: target,
              kind: "reading-view" as const,
              markdown,
              section: { lineEnd: 0, lineStart: 0, text: markdown },
              sectionFrom: 0,
              sectionTo: markdown.length,
              sourcePath: "notes/note.md",
            };
      const result = harness.actions.deleteEmbed(reference);
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
      const changed = `${markdown}\nNew text`;
      if (source === "editor")
        harness.editor.replaceRange("\nNew text", harness.editor.offsetToPos(markdown.length));
      else harness.setVaultText(changed);
      pending.settle(true);
      await expect(result).resolves.toEqual({ kind: "unavailable", reason: "editor-changed" });
      expect(source === "editor" ? harness.editor.value() : harness.vaultText()).toBe(changed);
      expect(harness.process).not.toHaveBeenCalled();
      expect(harness.trashFile).not.toHaveBeenCalled();
    },
  );

  it("preserves both embed and file when disposed during the file decision", async () => {
    const harness = createHarness();
    const file = deferredConfirmation();
    const prompt = vi
      .spyOn(dialogs, "confirmInkbookAction")
      .mockResolvedValueOnce(true)
      .mockReturnValueOnce(file.promise);
    const result = harness.actions.deleteEmbed(target);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    harness.actions.dispose();
    expect(prompt.mock.calls[1]?.[1].signal?.aborted).toBe(true);
    file.settle(false);
    await expect(result).resolves.toEqual({ kind: "cancelled", stage: "file" });
    expectUnchanged(harness);
  });
});
