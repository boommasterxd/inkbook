import { describe, expect, it, vi } from "vitest";

import { Localization, resolveLanguage } from "../../../../src/domain/localization";
import { english, german } from "../../../../src/domain/localization/catalogs";

describe("Localization", () => {
  it("resolves supported host variants and falls back to English", () => {
    expect(resolveLanguage("auto", "de-AT")).toBe("de");
    expect(resolveLanguage("auto", "DE_de")).toBe("de");
    expect(resolveLanguage("auto", "fr")).toBe("en");
    expect(resolveLanguage("en", "de")).toBe("en");
    expect(resolveLanguage("de", "fr")).toBe("de");
  });

  it("notifies only effective language changes and keeps separate instances independent", () => {
    const localization = new Localization("auto", "de");
    const other = new Localization();
    const listener = vi.fn();
    const release = localization.subscribe(listener);
    localization.setLanguage("de");
    expect(listener).not.toHaveBeenCalled();
    localization.setLanguage("en");
    expect(listener).toHaveBeenCalledOnce();
    localization.setLanguage("auto");
    expect(localization.language).toBe("de");
    expect(other.language).toBe("en");
    release();
    localization.setLanguage("en");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("interpolates complete messages and formats numbers, dates and plural categories", () => {
    const localization = new Localization("de");
    expect(localization.t("settings.folderConfirmation", { folder: "Notes/<b>" })).toBe(
      "Den Vault-Ordner „Notes/<b>“ erstellen?",
    );
    expect(localization.number(1234.5)).toBe("1.234,5");
    expect(localization.t("settings.controls.hertz", { value: 1234 })).toBe("1.234 Hz");
    expect(
      localization.date(new Date("2026-11-09T12:00:00Z"), {
        timeZone: "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
    ).toBe("09.11.2026");
    expect(localization.plural(1)).toBe("one");
    expect(localization.plural(2)).toBe("other");
    localization.setLanguage("en");
    expect(localization.number(1234.5)).toBe("1,234.5");
    expect(localization.t("settings.folderConfirmation", { folder: "Notes" })).toBe(
      "Create the vault folder “Notes”?",
    );
  });

  it("keeps catalog keys and interpolation contracts in parity", () => {
    expect(Object.keys(german).sort()).toEqual(Object.keys(english).sort());
    for (const key of Object.keys(english) as (keyof typeof english)[]) {
      const placeholders = (value: string) =>
        [...value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu)].map((match) => match[1]).sort();
      expect(placeholders(german[key]), key).toEqual(placeholders(english[key]));
    }
  });
});
