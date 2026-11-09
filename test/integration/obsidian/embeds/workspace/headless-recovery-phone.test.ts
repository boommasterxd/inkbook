// @vitest-environment happy-dom
import "../../../../fixtures/obsidian/menu-motion";

import type { App } from "obsidian";
import { expect, it, vi } from "vitest";
import { Localization } from "../../../../../src/domain/localization";
import { showHeadlessRecoveryNotice } from "../../../../../src/obsidian/embeds/workspace/recovery-notice";
import {
  dialogButton,
  installPhoneDialogTestLifecycle,
} from "../../../../fixtures/obsidian/dialog";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";

installPhoneDialogTestLifecycle();

it("opens localized phone recovery through the owning scheduler and releases its surface", () => {
  const app = { workspace: { containerEl: document.body } } as App;
  const localization = new Localization("de");
  const scheduler = workSchedulerFromFrames(window);
  const workScheduler = vi.fn(() => scheduler);
  const actions = {
    retry: vi.fn(() => false),
    reloadExternal: vi.fn(async () => false),
    saveLocalCopy: vi.fn(async () => false),
  };
  const notice = showHeadlessRecoveryNotice(
    app,
    actions,
    () => "reduced",
    localization,
    workScheduler,
  );
  vi.advanceTimersToNextFrame();
  const surface = document.querySelector<HTMLElement>(
    '.inkbook-adaptive-panel[data-kind="dialog"]',
  )!;
  expect(surface.isConnected).toBe(true);
  expect(surface.lang).toBe("de");
  expect(surface.getAttribute("aria-label")).toBe("Änderungen wiederherstellen");
  expect(workScheduler).toHaveBeenCalledWith(window);
  expect(document.activeElement).toBe(dialogButton("Erneut versuchen"));
  dialogButton("Erneut versuchen").click();
  expect(actions.retry).toHaveBeenCalledOnce();
  expect(surface.isConnected).toBe(true);
  localization.setLanguage("en");
  expect(surface.lang).toBe("en");
  expect(surface.getAttribute("aria-label")).toBe("Recover changes");
  expect(document.activeElement).toBe(dialogButton("Retry"));
  notice.close();
  expect(surface.isConnected).toBe(false);
  expect(surface.hasAttribute("lang")).toBe(false);
});
