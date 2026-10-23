// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";

import { type App, Platform } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { openContextMenu } from "../../../../src/obsidian/menus/context-menu";
import { createOwnedMenuFactory } from "../../../../src/obsidian/menus/owned-menu-factory";
import { createPhoneSheetHost } from "../../../../src/obsidian/menus/panels/phone-sheet-host";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { nativeModalStack, simulateNativeModalBack } from "../../../adapters/obsidian/settings";

import { createContextMenuHandlers } from "../../../adapters/obsidian/context-menu";

beforeEach(() => {
  installObsidianDomHelpers();
  vi.useFakeTimers();
  Platform.isMobile = true;
  Platform.isPhone = true;
});
afterEach(() => {
  document.body.replaceChildren();
  Platform.isMobile = false;
  Platform.isPhone = false;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([false, true])("keeps context focus restoration in the caller, keyboard=%s", (keyboard) => {
  const canvas = document.body.createEl("button", { cls: "inkbook-root" });
  canvas.dataset.inkbookMotion = "full";
  const trigger = document.body.createEl("button");
  const canvasFocus = vi.spyOn(canvas, "focus");
  const triggerFocus = vi.spyOn(trigger, "focus");
  const app = { workspace: { containerEl: document.body } } as App;
  const factory = createOwnedMenuFactory({
    anchor: canvas,
    workScheduler: workSchedulerFromFrames(window),
    createPhoneSheetHost: () => createPhoneSheetHost(app),
  });
  const handlers = createContextMenuHandlers();
  const closed = vi.fn();
  const session = openContextMenu(
    factory,
    {
      type: "position",
      position: { x: 10, y: 10 },
      ownerDocument: document,
      canvasInputSurface: canvas,
      returnFocus: trigger,
      restoreFocus: keyboard,
      onClosed: closed,
    },
    {
      hasSelection: false,
      canPaste: false,
      canBringForward: false,
      canSendBackward: false,
      canBringToFront: false,
      canSendToBack: false,
    },
    handlers,
  );
  vi.advanceTimersToNextFrame();
  canvasFocus.mockClear();
  triggerFocus.mockClear();
  simulateNativeModalBack(document);
  vi.advanceTimersByTime(220);
  expect(canvasFocus).not.toHaveBeenCalled();
  expect(triggerFocus).toHaveBeenCalledTimes(keyboard ? 1 : 0);
  if (keyboard) expect(document.activeElement).toBe(trigger);
  expect(closed).toHaveBeenCalledOnce();
  expect(nativeModalStack(document)).toHaveLength(0);
  session.close("immediate");
  expect(triggerFocus).toHaveBeenCalledTimes(keyboard ? 1 : 0);
  expect(vi.getTimerCount()).toBe(0);
});
