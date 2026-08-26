import type { Command, Editor } from "obsidian";

import type { ContextMenuAction } from "../menus";

export type InkbookCommandAction = ContextMenuAction | "lock";

export interface CommandRegistrationPort {
  addCommand(command: Command): Command;
}

export interface ContextualCommandRuntimePort {
  execute(action: InkbookCommandAction): void;
  isAvailable(action: InkbookCommandAction): boolean;
}

export interface EditorInsertionCommandPort {
  canInsert(editor: Editor, sourcePath: string): boolean;
  request(editor: Editor, sourcePath: string): boolean;
}

export interface PlacementFallbackFeedbackPort {
  show(fallback: "attachment-folder-unavailable" | "custom-folder-unavailable"): void;
}
