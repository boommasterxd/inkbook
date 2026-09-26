import { vi } from "vitest";
import { ActiveEditorActions } from "../../../src/obsidian/embeds/active-editor/controller-actions";
import { ActiveEditorHistory } from "../../../src/obsidian/embeds/active-editor/history";
import type { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../src/obsidian/embeds/vault-document-session";

export function activeActions(
  model: EditableDocumentModel,
  sceneStore: ElementSceneStore,
  ownerWindow: Window,
  onStateChanged: () => void,
  selection: ReadonlySet<string> | (() => ReadonlySet<string>) = new Set(),
  onFeedback?: (code: import("../../../src/obsidian/feedback").InkbookFeedbackCode) => void,
): ActiveEditorActions {
  return new ActiveEditorActions({
    renderer: { setElementFade: vi.fn(), clearElementFade: vi.fn() },
    currentSelection: typeof selection === "function" ? selection : () => selection,
    history: new ActiveEditorHistory(model),
    isAttached: () => true,
    isEnabled: () => true,
    lastSessionPointer: () => null,
    model,
    onCopyEmbed: vi.fn(),
    onDeleteEmbed: vi.fn(),
    ...(onFeedback === undefined ? {} : { onFeedback }),
    onPasteCommitted: vi.fn(),
    onPendingChanged: vi.fn(),
    onStateChanged,
    ownerWindow,
    sceneStore,
    setSelection: vi.fn(),
    visibleCenter: () => ({ x: 100, y: 100 }),
  });
}
