import { TFile, type Plugin } from "obsidian";
import { expect, it, vi } from "vitest";

import { registerVaultLifecycle } from "../../../../src/obsidian/runtime/vault-lifecycle";
import type { ObsidianInkbookDocumentRecognition } from "../../../../src/obsidian/embeds/preview/document-recognition";
import type { ObsidianWorkspaceRuntime } from "../../../../src/obsidian/embeds/workspace/workspace-runtime";

it("invalidates deleted and renamed SVG targets and reuses the guarded modification pipeline", () => {
  const events = new Map<string, (file: TFile, oldPath?: string) => void>();
  const recognition = {
    deferRefresh: vi.fn(),
    invalidate: vi.fn(),
    acceptConfirmedOutput: vi.fn(),
  };
  const runtime = {
    handleVaultModification: vi.fn((_path: string, complete: (output: undefined) => void) =>
      complete(undefined),
    ),
  };
  const plugin = {
    app: {
      vault: {
        on: (event: string, handler: (file: TFile, oldPath?: string) => void) =>
          events.set(event, handler),
      },
    },
    registerEvent: () => undefined,
  };
  registerVaultLifecycle(
    plugin as unknown as Plugin,
    runtime as unknown as ObsidianWorkspaceRuntime,
    recognition as unknown as ObsidianInkbookDocumentRecognition,
  );
  const File = TFile as unknown as new (path: string, size: number) => TFile;
  const drawing = new File("drawings/current.svg", 100);
  events.get("rename")!(drawing, "drawings/previous.svg");
  expect(recognition.invalidate.mock.calls).toEqual([
    ["drawings/previous.svg"],
    ["drawings/current.svg"],
  ]);
  expect(runtime.handleVaultModification).toHaveBeenCalledExactlyOnceWith(
    "drawings/current.svg",
    expect.any(Function),
  );
  expect(recognition.deferRefresh).toHaveBeenCalledExactlyOnceWith("drawings/current.svg");
  events.get("delete")!(drawing);
  expect(recognition.invalidate).toHaveBeenLastCalledWith("drawings/current.svg");
  events.get("delete")!(new File("notes/note.md", 100));
  expect(recognition.invalidate).toHaveBeenCalledTimes(3);
});
