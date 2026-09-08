import type { Command } from "obsidian";

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
}

const CONTEXTUAL_COMMANDS: readonly ContextualCommandDefinition[] = [
  { action: "lock", id: "lock-active-embed", name: "Lock active handwriting embed" },
  { action: "copy-embed", id: "copy-embed", name: "Copy active embed" },
  { action: "erase-all", id: "erase-all", name: "Erase all annotations" },
  { action: "delete-embed", id: "delete-embed", name: "Delete active embed" },
];

function contextualCommand(
  definition: ContextualCommandDefinition,
  runtime: ContextualCommandRuntimePort,
): Command {
  return {
    id: definition.id,
    name: definition.name,
    checkCallback: (checking) => {
      if (!runtime.isAvailable(definition.action)) return false;
      if (!checking) runtime.execute(definition.action);
      return true;
    },
  };
}

function insertionCommand(insertion: EditorInsertionCommandPort): Command {
  return {
    id: "insert-handwriting",
    name: "Insert handwriting embed",
    editorCheckCallback: (checking, editor, context) => {
      const sourcePath = context.file?.path;
      if (sourcePath === undefined || !insertion.canInsert(editor, sourcePath)) return false;
      return checking || insertion.request(editor, sourcePath);
    },
  };
}

export function registerInkbookCommands(
  host: CommandRegistrationPort,
  runtime: ContextualCommandRuntimePort,
  insertion: EditorInsertionCommandPort,
): void {
  for (const definition of CONTEXTUAL_COMMANDS) {
    host.addCommand(contextualCommand(definition, runtime));
  }
  host.addCommand(insertionCommand(insertion));
}
