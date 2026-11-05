// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { refreshSettingsView } from "../../../../src/obsidian/settings/settings-view-refresh";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { mockSettingsScrollOwner } from "../../../fixtures/obsidian/settings-scroll";

beforeEach(() => {
  installObsidianDomHelpers();
  mockSettingsScrollOwner(".settings-test-scroll-owner", "auto");
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each(["container", "ancestor"])(
  "restores the %s scroll owner and replaced control focus",
  (kind) => {
    const owner = document.body.createDiv({ cls: "settings-test-scroll-owner" });
    const container = kind === "container" ? owner : owner.createDiv();
    const mount = (): HTMLInputElement => {
      const row = container.createDiv();
      row.dataset.inkbookSettingIdentity = "setting";
      const input = row.createEl("input");
      input.setAttribute("aria-label", "Value");
      return input;
    };
    mount().focus();
    owner.scrollTop = 700;

    refreshSettingsView(container, () => {
      container.replaceChildren();
      owner.scrollTop = 0;
      mount();
    });

    expect(owner.scrollTop).toBe(700);
    expect(document.activeElement).toBe(container.querySelector("input"));
    if (kind === "ancestor") expect(container.scrollTop).toBe(0);
  },
);

it("keeps the visible row in place when reset removes conditional content above it", () => {
  const container = document.body.createDiv({ cls: "settings-test-scroll-owner" });
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 300));
  const mount = (offset: number): HTMLElement => {
    const row = container.createDiv();
    row.dataset.inkbookSettingIdentity = "reset";
    row.tabIndex = 0;
    vi.spyOn(row, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, offset - container.scrollTop, 600, 100),
    );
    return row;
  };
  mount(750).focus();
  container.scrollTop = 700;

  refreshSettingsView(container, () => {
    container.replaceChildren();
    container.scrollTop = 0;
    mount(650);
  });

  expect(container.scrollTop).toBe(600);
  expect(document.activeElement?.getBoundingClientRect().top).toBe(50);
});

it("does not move focus from a different open surface", () => {
  const external = document.body.createEl("button");
  const container = document.body.createDiv();
  external.focus();

  refreshSettingsView(container, () => container.replaceChildren());

  expect(document.activeElement).toBe(external);
});

it("anchors a visible shortcut row instead of its overlapping outer section", () => {
  const container = document.body.createDiv({ cls: "settings-test-scroll-owner" });
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 300));
  const mount = (offset: number): HTMLElement => {
    const wrapper = container.createDiv();
    wrapper.dataset.inkbookSettingIdentity = "shortcut-wrapper";
    vi.spyOn(wrapper, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, 100 - container.scrollTop, 600, 2000),
    );
    const row = wrapper.createDiv();
    row.dataset.inkbookSettingIdentity = "shortcut-action";
    vi.spyOn(row, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, offset - container.scrollTop, 600, 50),
    );
    return row;
  };
  mount(750);
  container.scrollTop = 700;

  refreshSettingsView(container, () => {
    container.replaceChildren();
    mount(850);
  });

  expect(container.scrollTop).toBe(800);
  expect(
    container
      .querySelector('[data-inkbook-setting-identity="shortcut-action"]')
      ?.getBoundingClientRect().top,
  ).toBe(50);
});
