import type { Command, Menu, Editor, MarkdownFileInfo, MarkdownView } from "obsidian";

import type { InkbookCommandAction } from "./command-ports";
import type {
  CommandRegistrationPort,
  ContextualCommandRuntimePort,
  EditorInsertionCommandPort,
} from "./command-ports";

interface ContextualCommandDefinition {
  readonly action: InkbookCommandAction;
  readonly id: string;
  readonly name: string;
  readonly icon: string;
}

const CONTEXTUAL_COMMANDS: readonly ContextualCommandDefinition[] = [
  { action: "lock", id: "lock-active-embed", name: "Lock active handwriting embed", icon: "lock" },
  { action: "copy-embed", id: "copy-embed", name: "Copy active embed", icon: "copy" },
  { action: "erase-all", id: "erase-all", name: "Erase all annotations", icon: "eraser" },
  { action: "delete-embed", id: "delete-embed", name: "Delete active embed", icon: "trash-2" },
];

function contextualCommand(
  definition: ContextualCommandDefinition,
  runtime: ContextualCommandRuntimePort,
): Command {
  return {
    id: definition.id,
    name: definition.name,
    icon: definition.icon,
    checkCallback: (checking) => {
      if (!runtime.isAvailable(definition.action)) return false;
      if (!checking) runtime.execute(definition.action);
      return true;
    },
  };
}

export interface InkbookInsertionCommand extends Command {
  editorCheckCallback(
    checking: boolean,
    editor: Editor,
    context: MarkdownView | MarkdownFileInfo,
  ): boolean;
}

function insertionCommand(insertion: EditorInsertionCommandPort): InkbookInsertionCommand {
  return {
    id: "insert-handwriting",
    name: "Insert handwriting embed",
    icon: "signature",
    editorCheckCallback: (checking, editor, context) => {
      const sourcePath = context.file?.path;
      if (sourcePath === undefined) return false;
      return checking
        ? insertion.canInsert(editor, sourcePath)
        : insertion.request(editor, sourcePath);
    },
  };
}

export function registerInkbookCommands(
  host: CommandRegistrationPort,
  runtime: ContextualCommandRuntimePort,
  insertion: EditorInsertionCommandPort,
): InkbookInsertionCommand {
  for (const definition of CONTEXTUAL_COMMANDS) {
    host.addCommand(contextualCommand(definition, runtime));
  }
  const command = insertionCommand(insertion);
  host.addCommand(command);
  return command;
}

export function addInsertionContextMenuItem(
  command: InkbookInsertionCommand,
  menu: Menu,
  editor: Editor,
  context: MarkdownView | MarkdownFileInfo,
  targetLine?: number,
): void {
  if (targetLine === undefined && !command.editorCheckCallback(true, editor, context)) return;
  const line = targetLine ?? editor.getCursor().line;
  const sourcePath = context.file?.path;
  menu.addItem((item) => {
    item
      .setTitle(command.name)
      .setIcon(command.icon ?? "signature")
      .onClick(() => {
        if (context.file?.path !== sourcePath) return;
        editor.setCursor({ line, ch: 0 });
        command.editorCheckCallback(false, editor, context);
      });
  });
}
