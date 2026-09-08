import type { Command, Editor } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import {
  registerInkbookCommands,
  type CommandRegistrationPort,
  type ContextualCommandRuntimePort,
  type EditorInsertionCommandPort,
  type InkbookCommandAction,
} from "../../../../src/obsidian/commands";

class CommandHost implements CommandRegistrationPort {
  readonly commands: Command[] = [];

  addCommand(command: Command): Command {
    this.commands.push(command);
    return command;
  }
}

function findCommand(host: CommandHost, id: string): Command {
  const command = host.commands.find((candidate) => candidate.id === id);
  if (command === undefined) throw new Error(`Command ${id} was not registered.`);
  return command;
}

describe("Inkbook command registry", () => {
  it("registers host-safe commands without default hotkeys", () => {
    const host = new CommandHost();
    const runtime: ContextualCommandRuntimePort = {
      execute: vi.fn(),
      isAvailable: () => false,
    };
    const insertion: EditorInsertionCommandPort = {
      canInsert: () => false,
      request: vi.fn(() => false),
    };

    registerInkbookCommands(host, runtime, insertion);

    expect(host.commands.map(({ id }) => id)).toEqual([
      "lock-active-embed",
      "copy-embed",
      "erase-all",
      "delete-embed",
      "insert-handwriting",
    ]);
    expect(host.commands.every((command) => command.hotkeys === undefined)).toBe(true);
    expect(Object.fromEntries(host.commands.map(({ id, icon }) => [id, icon]))).toEqual({
      "lock-active-embed": "lock",
      "copy-embed": "copy",
      "erase-all": "eraser",
      "delete-embed": "trash-2",
      "insert-handwriting": "signature",
    });
  });

  it("hides unavailable canvas actions and executes available actions only outside checking", () => {
    const host = new CommandHost();
    const available = new Set<InkbookCommandAction>(["copy-embed"]);
    const execute = vi.fn();
    registerInkbookCommands(
      host,
      { execute, isAvailable: (action) => available.has(action) },
      { canInsert: () => false, request: () => false },
    );

    const copyEmbed = findCommand(host, "copy-embed");
    const eraseAll = findCommand(host, "erase-all");
    expect(copyEmbed.checkCallback?.(true)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(copyEmbed.checkCallback?.(false)).toBe(true);
    expect(execute).toHaveBeenCalledWith("copy-embed");
    expect(eraseAll.checkCallback?.(true)).toBe(false);
    expect(eraseAll.checkCallback?.(false)).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("uses editorCheckCallback and the current note path for insertion", () => {
    const host = new CommandHost();
    const editor = {} as Editor;
    const canInsert = vi.fn(() => true);
    const request = vi.fn(() => true);
    registerInkbookCommands(
      host,
      { execute: vi.fn(), isAvailable: () => false },
      { canInsert, request },
    );

    const command = findCommand(host, "insert-handwriting");
    const context = { file: { path: "notes/page.md" } };
    expect(command.editorCheckCallback?.(true, editor, context as never)).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(command.editorCheckCallback?.(false, editor, context as never)).toBe(true);
    expect(canInsert).toHaveBeenCalledWith(editor, "notes/page.md");
    expect(request).toHaveBeenCalledWith(editor, "notes/page.md");
    expect(command.checkCallback).toBeUndefined();
  });

  it("does not expose insertion without an active Markdown file", () => {
    const host = new CommandHost();
    const canInsert = vi.fn(() => true);
    const insertion: EditorInsertionCommandPort = {
      canInsert,
      request: vi.fn(() => true),
    };
    registerInkbookCommands(host, { execute: vi.fn(), isAvailable: () => false }, insertion);

    const command = findCommand(host, "insert-handwriting");
    expect(command.editorCheckCallback?.(true, {} as Editor, { file: null } as never)).toBe(false);
    expect(canInsert).not.toHaveBeenCalled();
  });
});
