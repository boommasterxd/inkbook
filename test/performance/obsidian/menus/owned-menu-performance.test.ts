// @vitest-environment happy-dom
import { setImmediate } from "node:timers";
import "../../../fixtures/obsidian/menu-motion";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";

import { Platform } from "obsidian";
import { expect, it, vi } from "vitest";

import { createOwnedMenuFactory } from "../../../../src/obsidian/menus/owned-menu-factory";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { INTERACTION_REFRESH_PROFILE } from "../../interaction-refresh-profile";

/** Complete twelve-action menu operation. */
function renderAndDisposeActionMenu(
  factory: ReturnType<typeof createOwnedMenuFactory>,
  onHide: () => void,
): void {
  const menu = factory.create("context");
  for (let index = 0; index < 12; index += 1) {
    if (index > 0 && index % 3 === 0) menu.addSeparator();
    menu.addItem((item) => {
      item
        .setTitle(`Action ${String(index)}`)
        .setIcon("copy")
        .setDisabled(index === 3);
      item.setChecked?.(index === 0);
    });
  }
  menu.onHide(onHide);
  menu.showAtPosition({ x: 50, y: 50 }, document);
  menu.close("immediate");
}

it("renders and disposes a complete action menu with bounded work", async () => {
  installObsidianDomHelpers();
  Platform.isPhone = false;
  Platform.isMobile = false;
  const anchor = window.createDiv();
  document.body.append(anchor);
  let scopes = 0;
  let disposed = 0;
  const factory = createOwnedMenuFactory({
    anchor,
    workScheduler: workSchedulerFromFrames(window),
    keymap: {
      pushScope: () => {
        scopes += 1;
      },
      popScope: () => {
        scopes -= 1;
      },
    },
  });
  const renderAndDispose = (): void => {
    renderAndDisposeActionMenu(factory, () => {
      disposed += 1;
    });
  };
  try {
    for (let frame = 0; frame < INTERACTION_REFRESH_PROFILE.sampleCount; frame += 1) {
      renderAndDispose();
      // Separate input tasks let gesture cleanup and AbortSignal jobs release detached targets.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(document.body.children).toHaveLength(1);
      expect(scopes).toBe(0);
    }

    expect(disposed).toBe(INTERACTION_REFRESH_PROFILE.sampleCount);
    expect(scopes).toBe(0);
    expect(document.body.children).toHaveLength(1);
  } finally {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  }
});
