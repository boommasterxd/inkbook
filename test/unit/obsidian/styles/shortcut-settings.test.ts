import { sys } from "typescript";
import { describe, expect, it } from "vitest";

const stylesheet = sys.readFile(sys.resolvePath("src/obsidian/styles/shortcut-settings.css"));
if (stylesheet === undefined) throw new Error("Unable to read the shortcut settings stylesheet.");

describe("shortcut settings styles", () => {
  it("stretches wrapped phone shortcut fields across their complete row", () => {
    const phoneStart = stylesheet.indexOf("@media (width <= 600px)");
    expect(phoneStart).toBeGreaterThanOrEqual(0);
    const phone = stylesheet.slice(phoneStart);

    expect(phone).toContain(`.inkbook-shortcut-readonly-row {
    align-items: stretch;
    flex-direction: column;
  }`);
    expect(phone).toContain(`.inkbook-shortcut-recorder {
    flex: 1 1 auto;
    inline-size: auto;
    min-inline-size: 0;
  }`);
    expect(phone).not.toContain(".inkbook-shortcut-recorder-static");
  });
});
