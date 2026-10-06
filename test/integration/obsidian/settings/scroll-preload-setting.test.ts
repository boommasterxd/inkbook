// @vitest-environment happy-dom

import { beforeAll, describe, expect, it, vi } from "vitest";

import { InkbookSettingsStore } from "../../../../src/obsidian/settings/storage";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import {
  createTab,
  DeviceAdapter,
  groups,
  renderDefinition,
  requiredElement,
  requiredRender,
  renders,
  VaultAdapter,
} from "./setting-tab-fixture";

beforeAll(() => installObsidianDomHelpers());

function renderMargin(store: InkbookSettingsStore) {
  const performance = groups(createTab(store)).find((group) => group.heading === "Performance");
  if (performance === undefined) throw new Error("Missing Performance settings group.");
  return renderDefinition(requiredRender(renders(performance), "Scroll preload margin"));
}

describe("scroll preload margin setting", () => {
  it("synchronizes slider and pixel field and persists one commit per change", async () => {
    const device = new DeviceAdapter();
    const vault = new VaultAdapter();
    const store = new InkbookSettingsStore(vault, device);
    const rendered = renderMargin(store);
    const slider = requiredElement<HTMLInputElement>(rendered.container, "input[type='range']");
    const field = requiredElement<HTMLInputElement>(rendered.container, "input[type='number']");

    expect(slider.min).toBe("100");
    expect(slider.max).toBe("800");
    expect(slider.step).toBe("1");
    expect(slider.value).toBe("300");
    expect(field.value).toBe("300");
    expect(field.getAttribute("aria-label")).toBe("Screen pixels");
    expect(field.getAttribute("aria-describedby")).toContain("scroll-preload-margin-description");

    slider.value = "800";
    slider.dispatchEvent(new Event("input"));
    expect(field.value).toBe("800");
    expect(device.saves).toBe(0);
    slider.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(device.value.scrollPreloadMarginPx).toBe(800));

    field.value = "101";
    field.dispatchEvent(new Event("input"));
    expect(slider.value).toBe("101");
    expect(device.saves).toBe(1);
    field.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(device.value.scrollPreloadMarginPx).toBe(101));
    expect(device.saves).toBe(2);
    expect(vault.saves).toBe(0);
    rendered.cleanup();
  });

  it.each(["99", "801", "", "300.5"])(
    "reports invalid pixel value %s without persisting it",
    async (invalidValue) => {
      const device = new DeviceAdapter();
      const store = new InkbookSettingsStore(new VaultAdapter(), device);
      const rendered = renderMargin(store);
      const field = requiredElement<HTMLInputElement>(rendered.container, "input[type='number']");
      field.value = invalidValue;
      field.dispatchEvent(new Event("change"));

      await vi.waitFor(() => {
        const error = requiredElement<HTMLElement>(
          rendered.container,
          ".inkbook-settings-control-error",
        );
        expect(error.hidden).toBe(false);
      });
      expect(device.saves).toBe(0);
      expect(store.getDeviceSettings().scrollPreloadMarginPx).toBe(300);
      expect(
        requiredElement<HTMLInputElement>(rendered.container, "input[type='number']").value,
      ).toBe("300");
      rendered.cleanup();
    },
  );
});
