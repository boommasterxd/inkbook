// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";
import { beforeEach, expect, it, vi } from "vitest";

import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { openTestSettingsModal } from "../../../fixtures/obsidian/settings-store";
import { mockSettingsScrollOwner } from "../../../fixtures/obsidian/settings-scroll";

beforeEach(() => {
  installObsidianDomHelpers();
  document.body.replaceChildren();
  mockSettingsScrollOwner(".inkbook-settings-modal-body");
});

it("changes language inside the open settings modal while retaining focus, scroll and disclosure state", async () => {
  const { store, controller } = openTestSettingsModal(undefined, "reduced");
  const modal = required<HTMLElement>(".inkbook-settings-modal");
  const pen = required<HTMLButtonElement>('[aria-controls="inkbook-settings-tool-draw"]');
  pen.click();
  expect(pen.getAttribute("aria-expanded")).toBe("true");
  const body = required<HTMLElement>(".inkbook-settings-modal-body");
  body.scrollTop = 750;
  const select = required<HTMLSelectElement>('select[aria-label="Language"]');
  expect([...select.options].map((option) => option.text)).toEqual(["Auto", "Deutsch", "English"]);
  select.focus();
  select.value = "de";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await vi.waitFor(() => expect(modal.getAttribute("aria-label")).toBe("Inkbook-Einstellungen"));
  expect(required(".inkbook-settings-modal")).toBe(modal);
  expect(store.getDeviceSettings().language).toBe("de");
  expect(document.activeElement).toBe(required('select[aria-label="Sprache"]'));
  expect(body.scrollTop).toBe(750);
  expect(
    required('[aria-controls="inkbook-settings-tool-draw"]').getAttribute("aria-expanded"),
  ).toBe("true");
  expect(required('select[aria-label="Sprache"]').getAttribute("aria-label")).toBe("Sprache");
  expect(
    required(
      '#inkbook-settings-tool-draw [data-control="opacity"] input[type="number"]',
    ).getAttribute("aria-label"),
  ).toBe(store.localization.t("editor.style.percent", { label: "Deckkraft" }));
  expect(required(".inkbook-settings-general-group").textContent).toContain("Allgemein");
  expect(document.querySelector(".inkbook-settings-interface-group")).toBeNull();
  for (const group of ["general", "input"]) {
    const reset = required<HTMLElement>(
      `.inkbook-settings-${group}-group [data-setting-name="Gruppe zurücksetzen"]`,
    );
    expect(reset.dataset.settingDescription).toBe(
      store.localization.t("settings.controls.resetHelp"),
    );
  }
  const confirmed = store.getDeviceSettings();
  required<HTMLElement>('[data-setting-name="Alle Inkbook-Einstellungen zurücksetzen"]').click();
  const cancel = [
    ...document.querySelectorAll<HTMLButtonElement>(".inkbook-dialog-actions button"),
  ].find((button) => button.textContent === "Abbrechen");
  expect(cancel).toBeDefined();
  cancel?.click();
  await vi.waitFor(() => expect(document.querySelector(".inkbook-dialog-actions")).toBeNull());
  expect(store.getDeviceSettings()).toEqual(confirmed);
  controller.dispose();
});

function required<T extends Element = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing ${selector}`);
  return element;
}
