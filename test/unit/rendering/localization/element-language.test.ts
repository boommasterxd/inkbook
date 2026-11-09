// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { Localization } from "../../../../src/domain/localization";
import { bindElementLanguage } from "../../../../src/rendering/localization/element-language";

it("overrides only the owned part and restores its original language after updates", () => {
  const host = document.createElement("div");
  host.lang = "en";
  const owned = host.appendChild(document.createElement("section"));
  owned.lang = "fr";
  const localization = new Localization("de");
  const release = bindElementLanguage(owned, localization);
  expect(owned.lang).toBe("de");
  expect(host.lang).toBe("en");
  localization.setLanguage("en");
  expect(owned.lang).toBe("en");
  release();
  expect(owned.lang).toBe("fr");
  localization.setLanguage("de");
  expect(owned.lang).toBe("fr");
});

it("restores inherited language when an owned root had no explicit language", () => {
  const host = document.createElement("main");
  host.lang = "en";
  const owned = host.appendChild(document.createElement("section"));
  const localization = new Localization("de");
  const release = bindElementLanguage(owned, localization);
  expect(owned.lang).toBe("de");
  expect(host.lang).toBe("en");
  release();
  expect(owned.hasAttribute("lang")).toBe(false);
  localization.setLanguage("en");
  expect(owned.hasAttribute("lang")).toBe(false);
});
