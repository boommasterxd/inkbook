import type { App } from "obsidian";

import { EditorToolbarMenuSession } from "../../../src/obsidian/menus/editor-toolbar-menu";
import type { EditorToolbarMenuOptions, EditorToolbarMenuState } from "../../../src/obsidian/menus";
import { createOwnedMenuFactory } from "../../../src/obsidian/menus/owned-menu-factory";
import { createPhoneSheetHost } from "../../../src/obsidian/menus/panels/phone-sheet-host";
import type { MotionPreference } from "../../../src/rendering/motion/transitions";
import { createEditorToolbarMenuOptions } from "../../adapters/obsidian/editor-toolbar-menu";

export function createOwnedToolbarMenuFixture({
  initialMenu = "overflow",
  motion = "full",
  state = {},
}: {
  initialMenu?: EditorToolbarMenuOptions["initialMenu"];
  motion?: MotionPreference;
  state?: Partial<EditorToolbarMenuState>;
} = {}) {
  const options = createEditorToolbarMenuOptions(state);
  options.anchor.className = "inkbook-root";
  options.anchor.dataset.inkbookMotion = motion;
  options.anchor.setAttribute("aria-label", "More options");
  document.body.append(options.anchor);
  const app = { workspace: { containerEl: document.body } } as App;
  const host = () => createPhoneSheetHost(app);
  const factory = createOwnedMenuFactory({
    anchor: options.anchor,
    workScheduler: options.workScheduler,
    createPhoneSheetHost: host,
  });
  const session = new EditorToolbarMenuSession({
    ...options,
    factory,
    createPhoneSheetHost: host,
    initialMenu,
  });
  return { options, session };
}
