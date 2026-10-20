import type { Editor } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { EmbedPasteController } from "../../../../src/obsidian/commands/embed-paste";
import { ownedFileRead } from "../../../fixtures/obsidian/owned-file";

function harness() {
  const owner = new AbortController();
  const replaceRange = vi.fn();
  const editor = {
    getCursor: () => ({ ch: 0, line: 0 }),
    getRange: () => "",
    getValue: () => "",
    replaceRange,
  } as unknown as Editor;
  const request = {
    clipboardText: "!inkbook[[source.svg]]",
    editor,
    insideInkWidget: false,
    sourcePath: "note.md",
  };
  const read = (path: string) => ({
    content: "drawing",
    identity: { ctime: 0, mtime: 0, path, size: 7 },
    materialization: "host-full-read-not-bounded" as const,
    stabilityEvidence: "object-identity-and-stat-unchanged" as const,
  });
  const choose = vi.fn(async (): Promise<"duplicate" | "reference" | null> => "duplicate");
  const readSource = vi.fn(async () => read("source.svg"));
  const create = vi.fn(async () => read("duplicate.svg"));
  const validate = vi.fn(async () => true);
  const preparePath = vi.fn(async () => "duplicate.svg");
  const trash = vi.fn(async (_path: string) => undefined);
  const controller = new EmbedPasteController({
    signal: owner.signal,
    choices: { choose },
    documents: {
      createOwnedAndReadBack: async (_path, _content, _maximumBytes, onCreated) =>
        ownedFileRead("duplicate.svg", await create(), onCreated),
      readWithMetadataGuard: readSource,
    },
    links: {
      generateEmbed: () => "!inkbook[[duplicate.svg]]",
      resolveLinkTarget: () => ({ path: "source.svg" }),
    },
    placement: { preparePath },
    trash: { trashCreated: (created) => trash(created.file.path) },
    validation: { validate },
  });
  return {
    owner,
    replaceRange,
    request,
    choose,
    readSource,
    create,
    validate,
    preparePath,
    trash,
    controller,
  };
}

describe("copied embed paste owner lifetime", () => {
  it("ignores new host interception after abort and cancels direct calls", async () => {
    const test = harness();
    test.owner.abort();
    expect(test.controller.canHandle(test.request)).toBe(false);
    await expect(test.controller.paste(test.request)).resolves.toEqual({ kind: "cancelled" });
    expect(test.readSource).not.toHaveBeenCalled();
    expect(test.choose).not.toHaveBeenCalled();
  });

  it.each(["read", "read failure", "validate", "invalid", "choose", "placement"])(
    "stops before creation or editor mutation when aborted during %s",
    async (phase) => {
      const test = harness();
      if (phase === "read" || phase === "read failure") {
        const original = test.readSource.getMockImplementation();
        test.readSource.mockImplementationOnce(async () => {
          test.owner.abort();
          if (phase === "read failure") throw new Error("read failed");
          return original!();
        });
      } else if (phase === "validate" || phase === "invalid") {
        test.validate.mockImplementationOnce(async () => {
          test.owner.abort();
          return phase !== "invalid";
        });
      } else if (phase === "choose") {
        test.choose.mockImplementationOnce(async () => {
          test.owner.abort();
          return "duplicate";
        });
      } else {
        test.preparePath.mockImplementationOnce(async () => {
          test.owner.abort();
          return "duplicate.svg";
        });
      }
      await expect(test.controller.paste(test.request)).resolves.toEqual({ kind: "cancelled" });
      expect(test.create).not.toHaveBeenCalled();
      expect(test.replaceRange).not.toHaveBeenCalled();
      if (["read", "read failure", "validate", "invalid"].includes(phase)) {
        expect(test.choose).not.toHaveBeenCalled();
      }
    },
  );
});

describe("copied embed paste duplication lifetime", () => {
  it("trashes the duplicate when its owner aborts during readback", async () => {
    const test = harness();
    const original = test.create.getMockImplementation();
    test.create.mockImplementationOnce(async () => {
      test.owner.abort();
      return original!();
    });
    await expect(test.controller.paste(test.request)).resolves.toEqual({
      kind: "stale",
      cleanup: "trashed",
    });
    expect(test.trash).toHaveBeenCalledExactlyOnceWith("duplicate.svg");
    expect(test.replaceRange).not.toHaveBeenCalled();
  });

  it("blocks concurrent pastes until the pending choice is settled", async () => {
    const test = harness();
    let resolveChoice: ((choice: null) => void) | undefined;
    test.choose.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveChoice = resolve;
        }),
    );
    const pending = test.controller.paste(test.request);
    await vi.waitFor(() => expect(test.choose).toHaveBeenCalledOnce());
    await expect(test.controller.paste(test.request)).resolves.toEqual({ kind: "cancelled" });
    expect(test.readSource).toHaveBeenCalledOnce();
    resolveChoice?.(null);
    await expect(pending).resolves.toEqual({ kind: "cancelled" });
    await expect(test.controller.paste(test.request)).resolves.toEqual({
      kind: "inserted",
      mode: "duplicate",
    });
    expect(test.create).toHaveBeenCalledOnce();
  });
});
