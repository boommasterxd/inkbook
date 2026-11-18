// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { preparedLibraryFont as prepared } from "../../../fixtures/obsidian/prepared-library-font";
import { installFontSettingsLifecycle } from "../../../fixtures/obsidian/font-settings-lifecycle";
import {
  button,
  file,
  fontLibrarySettingsFixture as fixture,
  selectFiles,
} from "../../../fixtures/obsidian/font-library-settings";

installFontSettingsLifecycle();

it("flags overlapping staged and existing faces before review and lets users remove files in place", async () => {
  const context = fixture(1);
  const regular = prepared();
  const variable = prepared("Variable.woff2", 450);
  const variableRange: [number, number] = [400, 700];
  const italic = prepared("Italic.woff2", 700);
  context.prepare
    .mockResolvedValueOnce(regular)
    .mockResolvedValueOnce({
      ...variable,
      weightRange: variableRange,
      resource: { ...variable.resource, weightRange: variableRange },
    })
    .mockResolvedValueOnce({
      ...italic,
      style: "italic",
      resource: { ...italic.resource, style: "italic" },
    });
  try {
    button(context.section, "Add font").click();
    selectFiles(context.section, [
      file(regular.fileName),
      file(variable.fileName),
      file(italic.fileName),
    ]);
    await vi.waitFor(() => expect(button(context.section, "Next").disabled).toBe(false));
    button(context.section, "Next").click();
    const issue = (name: string) => {
      const remove = button(context.section, `Remove ${name} from selection`);
      return document.getElementById(remove.getAttribute("aria-describedby")!);
    };
    expect(issue(regular.fileName)?.textContent).toContain("overlaps");
    expect(issue(variable.fileName)?.textContent).toContain("overlaps");
    expect(issue(italic.fileName)?.textContent).toBe("");
    expect(button(context.section, "Next").disabled).toBe(true);
    const show = button(context.section, "Show file");
    expect(show.hidden).toBe(false);
    expect(document.getElementById(show.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Font styles overlap.",
    );
    const remove = button(context.section, "Remove Example.ttf from selection");
    const reveal = vi.spyOn(remove.closest("li")!, "scrollIntoView");
    show.focus();
    show.click();
    expect(reveal).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(remove);
    remove.click();
    expect(document.activeElement).toBe(
      button(context.section, "Remove Variable.woff2 from selection"),
    );
    expect(button(context.section, "Next").disabled).toBe(false);
    expect(button(context.section, "Show file").hidden).toBe(true);
    const destination = context.section.querySelector<HTMLSelectElement>(
      '[data-inkbook-setting-identity="font-import-family"] select',
    )!;
    destination.focus();
    destination.value = context.library.list()[0]!.family;
    destination.dispatchEvent(new Event("change"));
    expect(document.activeElement).toBe(destination);
    expect(issue(variable.fileName)?.textContent).toContain("overlaps");
    expect(button(context.section, "Next").disabled).toBe(true);
    expect(button(context.section, "Show file").hidden).toBe(false);
    expect(context.commit).not.toHaveBeenCalled();
    destination.value = "";
    destination.dispatchEvent(new Event("change"));
    expect(document.activeElement).toBe(destination);
    expect(button(context.section, "Show file").hidden).toBe(true);
    button(context.section, "Next").click();
    button(context.section, "Remove Italic.woff2 from selection").click();
    button(context.section, "Add font").click();
    await vi.waitFor(() => expect(context.changed).toHaveBeenCalledOnce());
    expect(context.commit).toHaveBeenCalledWith(
      [expect.objectContaining({ id: variable.id })],
      { displayName: "Example" },
      expect.any(AbortSignal),
    );
    expect(context.prepare).toHaveBeenCalledTimes(3);
  } finally {
    context.dispose();
  }
});
