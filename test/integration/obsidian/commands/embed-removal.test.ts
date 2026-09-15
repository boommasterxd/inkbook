import { describe, expect, it, vi } from "vitest";
import { createHarness } from "./embed-actions-fixture";

describe("confirmed embed removal transition", () => {
  it("waits until collapse finishes before changing Markdown or trashing the file", async () => {
    const h = createHarness();
    let finish: (completed: boolean) => void = () => undefined;
    const removal = {
      begin: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      ),
      reset: vi.fn(),
    };
    const result = h.actions.deleteEmbed("drawings/page.svg", removal);
    await vi.waitFor(() => expect(removal.begin).toHaveBeenCalledOnce());
    expect(h.confirm).toHaveBeenCalledTimes(2);
    expect(h.editor.value()).toContain("!inkbook");
    expect(h.trashFile).not.toHaveBeenCalled();
    finish(true);
    await expect(result).resolves.toEqual({ kind: "deleted", fileDeleted: true });
    expect(h.editor.value()).toBe("");
    expect(removal.reset).not.toHaveBeenCalled();
  });

  it.each(["changed", "cancelled", "disposed", "metadata", "error"])(
    "restores the root for %s during collapse",
    async (reason) => {
      const h = createHarness();
      const removal = {
        begin: vi.fn(async () => {
          if (reason === "changed") h.editor.replaceRange("changed", { line: 0, ch: 0 });
          if (reason === "disposed") h.actions.dispose();
          if (reason === "metadata") h.setMetadataResolved(false);
          if (reason === "error") throw new Error("transition failed");
          return reason !== "cancelled";
        }),
        reset: vi.fn(),
      };
      const result = h.actions.deleteEmbed("drawings/page.svg", removal);
      if (reason === "error") await expect(result).rejects.toThrow("transition failed");
      else expect((await result).kind).not.toBe("deleted");
      expect(h.editor.value()).toContain("!inkbook");
      expect(h.trashFile).not.toHaveBeenCalled();
      expect(removal.reset).toHaveBeenCalled();
    },
  );
});

it("uses the invoking presentation mutation hook and fails closed if it rejects the changed view", async () => {
  const h = createHarness({ references: 2 });
  const removeMarkdown = vi.fn(() => false);
  const removal = { begin: vi.fn(async () => true), reset: vi.fn(), removeMarkdown };
  const result = await h.actions.deleteEmbed("drawings/page.svg", removal);
  expect(result).toEqual({ kind: "unavailable", reason: "editor-changed" });
  expect(removeMarkdown).toHaveBeenCalledExactlyOnceWith(
    { from: 0, to: h.editor.value().length },
    h.editor.value(),
    expect.any(Function),
  );
  expect(h.editor.value()).toContain("!inkbook");
  expect(removal.reset).toHaveBeenCalledOnce();
});

it("retains the Obsidian Editor mutation when preserving presentation scroll", async () => {
  const h = createHarness({ references: 2 });
  const replaceRange = vi.spyOn(h.editor, "replaceRange");
  const removal = {
    begin: vi.fn(async () => true),
    reset: vi.fn(),
    removeMarkdown: vi.fn((_range: unknown, _source: string, mutate: () => void) => {
      mutate();
      return true;
    }),
  };
  await expect(h.actions.deleteEmbed("drawings/page.svg", removal)).resolves.toEqual({
    kind: "deleted",
    fileDeleted: false,
  });
  expect(replaceRange).toHaveBeenCalledOnce();
  expect(h.editor.value()).toBe("");
  expect(removal.reset).not.toHaveBeenCalled();
});
