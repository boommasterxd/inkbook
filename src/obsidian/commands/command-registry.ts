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
  { action: "copy", id: "copy-selection", name: "Copy selected annotations" },
  { action: "cut", id: "cut-selection", name: "Cut selected annotations" },
  { action: "delete", id: "delete-selection", name: "Delete selected annotations" },
  { action: "bring-forward", id: "bring-forward", name: "Bring selection forward" },
  { action: "send-backward", id: "send-backward", name: "Send selection backward" },
  { action: "bring-to-front", id: "bring-to-front", name: "Bring selection to front" },
  { action: "send-to-back", id: "send-to-back", name: "Send selection to back" },
  { action: "paste", id: "paste", name: "Paste annotations" },
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
