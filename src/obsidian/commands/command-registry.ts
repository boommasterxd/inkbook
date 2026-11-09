import { Localization, type Translator } from "../../domain/localization";
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
  readonly name: Parameters<Translator>[0];
  readonly icon: string;
}

const CONTEXTUAL_COMMANDS: readonly ContextualCommandDefinition[] = [
  { action: "lock", id: "lock-active-embed", name: "host.command.lock", icon: "lock" },
  { action: "copy-embed", id: "copy-embed", name: "host.command.copy-embed", icon: "copy" },
  { action: "erase-all", id: "erase-all", name: "host.command.erase-all", icon: "eraser" },
  {
    action: "delete-embed",
    id: "delete-embed",
    name: "host.command.delete-embed",
    icon: "trash-2",
  },
];

function contextualCommand(
  definition: ContextualCommandDefinition,
  runtime: ContextualCommandRuntimePort,
  t: Translator,
): Command {
  return {
    id: definition.id,
    name: t(definition.name),
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

function insertionCommand(
  insertion: EditorInsertionCommandPort,
  t: Translator,
): InkbookInsertionCommand {
  return {
    id: "insert-handwriting",
    name: t("host.command.insert"),
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
  localization = new Localization(),
): InkbookInsertionCommand {
  const registrations: Array<() => void> = [];
  for (const definition of CONTEXTUAL_COMMANDS) {
    const command = contextualCommand(definition, runtime, localization.t);
    registrations.push(
      registerLocalizedCommand(host, command, () => localization.t(definition.name)),
    );
  }
  const command = insertionCommand(insertion, localization.t);
  registrations.push(
    registerLocalizedCommand(host, command, () => localization.t("host.command.insert")),
  );
  const unsubscribe = localization.subscribe(() => {
    for (const update of registrations) update();
  });
  host.register?.(unsubscribe);
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

function registerLocalizedCommand(
  host: CommandRegistrationPort,
  command: Command,
  readName: () => string,
): () => void {
  const originalName = command.name;
  const registered = host.addCommand(command);
  const prefix = registered.name.endsWith(originalName)
    ? registered.name.slice(0, -originalName.length)
    : "";
  return () => {
    const name = readName();
    command.name = name;
    registered.name = `${prefix}${name}`;
  };
}
