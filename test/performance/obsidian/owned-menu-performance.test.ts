// @vitest-environment happy-dom

import { Platform } from "obsidian";
import { expect, it, vi } from "vitest";

import { createOwnedMenuFactory } from "../../../src/obsidian/menus/owned-menu-factory";
import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";
import { interactionP99, measureInteractionFrames } from "../interaction-refresh-profile";
import { timingBudget } from "../timing-budget";

it("renders and disposes a complete action menu inside the 240 Hz frame budget", async ({
  annotate,
}) => {
  installObsidianDomHelpers();
  Platform.isPhone = false;
  Platform.isMobile = false;
  const anchor = window.createDiv();
  document.body.append(anchor);
  let scopes = 0;
  let disposed = 0;
  const factory = createOwnedMenuFactory({
    anchor,
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
    menu.onHide(() => {
      disposed += 1;
    });
    menu.showAtPosition({ x: 50, y: 50 }, document);
    menu.close("immediate");
  };
  try {
    const durations = measureInteractionFrames(renderAndDispose);
    const p99 = interactionP99(durations);
    expect(p99).toBeLessThanOrEqual(timingBudget((1000 / 240) * 0.55));
    expect(disposed).toBe(durations.length);
    expect(scopes).toBe(0);
    expect(document.body.children).toHaveLength(1);
    await annotate(
      `Owned menu create/render/show/dispose: p99=${p99.toFixed(3)} ms; 240 Hz budget`,
      "performance",
    );
  } finally {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  }
});
