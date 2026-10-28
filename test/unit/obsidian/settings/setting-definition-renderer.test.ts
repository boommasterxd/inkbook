// @vitest-environment happy-dom

import type { SettingDefinitionControl } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingDefinitionRenderer } from "../../../../src/obsidian/settings/setting-definition-renderer";
import { nameSettingToggle } from "../../../../src/obsidian/settings/settings-row";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

beforeEach(() => {
  installObsidianDomHelpers();
  document.body.replaceChildren();
});

describe("named settings controls", () => {
  it.each(["dropdown", "text", "folder"] as const)(
    "names %s controls and persists user changes",
    (type) => {
      const setControlValue = vi.fn();
      const renderer = new SettingDefinitionRenderer(
        { getControlValue: () => "auto", setControlValue },
        vi.fn(),
      );
      const control =
        type === "dropdown"
          ? { type, key: "profile", options: { auto: "Automatic", "60": "60 Hz" } }
          : { type, key: "profile" };
      renderer.render(document.body, [{ name: "Display refresh rate", control }]);

      const input = document.querySelector<HTMLInputElement | HTMLSelectElement>(
        '[aria-label="Display refresh rate"]',
      )!;
      expect(input.value).toBe("auto");
      input.focus();
      input.value = "60";
      input.dispatchEvent(new Event(type === "dropdown" ? "change" : "input"));
      return vi.waitFor(() => {
        expect(setControlValue).toHaveBeenCalledExactlyOnceWith("profile", "60");
        renderer.dispose();
      });
    },
  );

  it("names toggles and persists their activation", () => {
    const setControlValue = vi.fn();
    const renderer = new SettingDefinitionRenderer(
      { getControlValue: () => false, setControlValue },
      vi.fn(),
    );
    const toggle: SettingDefinitionControl = {
      name: "Left-handed toolbar",
      control: { type: "toggle", key: "leftHandedToolbar" },
    };
    renderer.render(document.body, [toggle]);
    const input = document.querySelector<HTMLInputElement>('[aria-label="Left-handed toolbar"]')!;
    input.click();
    expect(setControlValue).toHaveBeenCalledExactlyOnceWith("leftHandedToolbar", true);
    expect(input.labels?.[0]?.hasAttribute("aria-label")).toBe(false);
    renderer.dispose();
  });

  it("names legacy host toggles on their exposed checkbox element", () => {
    const checkbox = document.body.createDiv();
    checkbox.setAttribute("role", "checkbox");
    nameSettingToggle(checkbox, "Finger drawing");
    expect(checkbox.getAttribute("aria-label")).toBe("Finger drawing");
  });
});

it.each(["toggle", "dropdown", "folder"] as const)(
  "restores the confirmed %s value on failure and keeps focus for retry",
  async (type) => {
    let value: boolean | string = type === "toggle" ? false : "original";
    let fail = true;
    const setControlValue = vi.fn((_key: string, next: unknown) => {
      if (fail) {
        if (type === "toggle") throw new Error("Storage unavailable");
        return Promise.reject(new Error("Storage unavailable"));
      }
      value = next as boolean | string;
      return Promise.resolve();
    });
    const renderer = new SettingDefinitionRenderer(
      {
        getControlValue: () => value,
        setControlValue,
        settingsFeedback: { readMotion: () => "reduced" },
      },
      vi.fn(),
    );
    const control =
      type === "dropdown"
        ? { type, key: "setting", options: { original: "Original", changed: "Changed" } }
        : { type, key: "setting" };
    renderer.render(document.body, [{ name: "Preference", control }]);
    const input = document.querySelector<HTMLInputElement | HTMLSelectElement>(
      '[aria-label="Preference"]',
    )!;
    const change = (): void => {
      if (type === "toggle") (input as HTMLInputElement).checked = true;
      else input.value = "changed";
      input.dispatchEvent(new Event(type === "folder" ? "input" : "change"));
    };
    input.focus();
    input.setAttribute("aria-describedby", "existing-description");
    change();
    await vi.waitFor(() =>
      expect(document.querySelector(".inkbook-settings-control-error")?.textContent).toBe(
        "The setting could not be saved.",
      ),
    );
    const error = document.querySelector<HTMLElement>(".inkbook-settings-control-error")!;
    expect(type === "toggle" ? (input as HTMLInputElement).checked : input.value).toBe(value);
    expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(error.id);
    expect(error.getAttribute("aria-live")).toBe("polite");
    expect(document.activeElement).toBe(input);
    expect(setControlValue).toHaveBeenCalledOnce();
    fail = false;
    change();
    await vi.waitFor(() => expect(value).toBe(type === "toggle" ? true : "changed"));
    expect(error.hidden).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(document.querySelector('[aria-label="Preference"]')).toBe(input);
    expect(setControlValue).toHaveBeenCalledTimes(2);
    renderer.dispose();
    expect(input.getAttribute("aria-describedby")).toBe("existing-description");
  },
);

it("does not save an older text draft when asynchronous validation completes later", async () => {
  const validation = new Map<string, (message?: string) => void>();
  const setControlValue = vi.fn();
  const renderer = new SettingDefinitionRenderer(
    { getControlValue: () => "initial", setControlValue },
    vi.fn(),
  );
  renderer.render(document.body, [
    {
      name: "Folder",
      control: {
        type: "folder",
        key: "folder",
        validate: (value) =>
          new Promise<string | undefined>((resolve) => validation.set(value, resolve)),
      },
    },
  ]);
  const input = document.querySelector<HTMLInputElement>('[aria-label="Folder"]')!;
  for (const value of ["older", "latest"]) {
    input.value = value;
    input.dispatchEvent(new Event("input"));
  }
  validation.get("latest")?.();
  await vi.waitFor(() =>
    expect(setControlValue).toHaveBeenCalledExactlyOnceWith("folder", "latest"),
  );
  validation.get("older")?.("Invalid older draft");
  await Promise.resolve();
  expect(document.querySelector(".inkbook-settings-control-error")).toBeNull();
  expect(input.value).toBe("latest");
  renderer.dispose();
});

it.each(["newer-draft", "disposed"] as const)(
  "ignores a failed pending write after %s",
  async (state) => {
    let rejectWrite: ((error: Error) => void) | undefined;
    const setControlValue = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );
    const renderer = new SettingDefinitionRenderer(
      {
        getControlValue: () => "original",
        setControlValue,
        settingsFeedback: { readMotion: () => "reduced" },
      },
      vi.fn(),
    );
    renderer.render(document.body, [
      {
        name: "Folder",
        control: {
          type: "folder",
          key: "folder",
          validate: (value) => (value === "invalid" ? "Invalid folder" : undefined),
        },
      },
    ]);
    const input = document.querySelector<HTMLInputElement>('[aria-label="Folder"]')!;
    input.value = "pending";
    input.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(setControlValue).toHaveBeenCalledOnce());
    if (state === "disposed") renderer.dispose();
    else {
      input.value = "invalid";
      input.dispatchEvent(new Event("input"));
      await vi.waitFor(() =>
        expect(document.querySelector(".inkbook-settings-control-error")?.textContent).toBe(
          "Invalid folder",
        ),
      );
    }
    rejectWrite?.(new Error("Save failed"));
    await Promise.resolve();
    expect(input.value).toBe(state === "disposed" ? "pending" : "invalid");
    expect(document.querySelector(".inkbook-settings-control-error")?.textContent).toBe(
      state === "disposed" ? undefined : "Invalid folder",
    );
    renderer.dispose();
    input.dispatchEvent(new Event("input"));
    expect(setControlValue).toHaveBeenCalledOnce();
  },
);
