import type { ActiveEditorActions } from "../../../src/obsidian/embeds/active-editor/controller-actions";
import { ActiveEditorMenuController } from "../../../src/obsidian/embeds/active-editor/controller-menu";
import type { MenuFactoryPort } from "../../../src/obsidian/menus/index";
import { immediateWorkScheduler } from "./immediate-work-scheduler";

/** Shared headless editor menu boundary for context and Clipboard tests. */
export function createActiveEditorMenuController(
  actions: ActiveEditorActions,
  factory: MenuFactoryPort,
  storeSize: number,
): ActiveEditorMenuController {
  return new ActiveEditorMenuController({
    actions,
    factory,
    inputSurface: { focus: () => undefined } as unknown as HTMLDivElement,
    ownerDocument: {} as Document,
    selectionSize: () => 0,
    storeSize: () => storeSize,
    toScreenPoint: (point) => point,
    workScheduler: immediateWorkScheduler(),
  });
}
