// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { installFontSettingsLifecycle } from "../../../fixtures/obsidian/font-settings-lifecycle";
import {
  fontLibrarySettingsFixture as fixture,
  button,
  selectFiles,
  file,
} from "../../../fixtures/obsidian/font-library-settings";
import { preparedLibraryFont as prepared } from "../../../fixtures/obsidian/prepared-library-font";

installFontSettingsLifecycle();

function changeName(section: HTMLElement, value: string): HTMLInputElement {
  const input = section.querySelector<HTMLInputElement>('input[type="text"]')!;
  input.value = value;
  input.dispatchEvent(new Event("input"));
  return input;
}

it("edits an existing font name and returns focus to the updated library entry", async () => {
  const context = fixture(1);
  try {
    const family = context.library.list()[0]!.family;
    button(context.section, "Edit Font 0").click();
    const input = changeName(context.section, "Personal font");
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
    expect(context.renamed).not.toHaveBeenCalled();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(context.changed).toHaveBeenCalledOnce());
    expect(context.renamed).toHaveBeenCalledExactlyOnceWith(family, "Personal font");
    expect(document.activeElement).toBe(button(context.section, "Edit Personal font"));
    expect(context.library.list()[0]!.family).toBe(family);
  } finally {
    context.dispose();
  }
});

it("cancels a name draft and retains a failed save for correction and retry", async () => {
  const context = fixture(1);
  try {
    button(context.section, "Edit Font 0").click();
    changeName(context.section, "Discard me");
    button(context.section, "Font library").click();
    expect(context.renamed).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button(context.section, "Edit Font 0"));
    button(context.section, "Edit Font 0").click();
    changeName(context.section, "   ");
    expect(button(context.section, "Save font name").disabled).toBe(true);
    const input = changeName(context.section, "My font");
    context.renamed.mockRejectedValueOnce(new Error("Storage unavailable"));
    button(context.section, "Save font name").click();
    await vi.waitFor(() =>
      expect(context.section.textContent).toContain("The font operation failed"),
    );
    expect(input.value).toBe("My font");
    expect(document.activeElement).toBe(input);
    expect(context.changed).not.toHaveBeenCalled();
    input.form!.requestSubmit();
    await vi.waitFor(() => expect(context.changed).toHaveBeenCalledOnce());
    expect(context.renamed).toHaveBeenCalledTimes(2);
  } finally {
    context.dispose();
  }
});

it("adds reviewed variants directly to the edited font without an assignment picker", async () => {
  const context = fixture(1);
  try {
    const family = context.library.list()[0]!.family;
    button(context.section, "Edit Font 0").click();
    changeName(context.section, "Unsaved name");
    button(context.section, "Add font styles").click();
    selectFiles(context.section);
    await vi.waitFor(() => expect(button(context.section, "Next").disabled).toBe(false));
    button(context.section, "Remove Example.ttf from selection").click();
    selectFiles(context.section, [file("Example-Bold.ttf")]);
    await vi.waitFor(() => expect(button(context.section, "Next").disabled).toBe(false));
    button(context.section, "Next").click();
    expect(context.section.querySelector("select")).toBeNull();
    const input = context.section.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(input.value).toBe("Font 0");
    expect(input.disabled).toBe(true);
    button(context.section, "Next").click();
    button(context.section, "Add font").click();
    await vi.waitFor(() => expect(context.changed).toHaveBeenCalledOnce());
    expect(context.commit).toHaveBeenCalledExactlyOnceWith(
      [prepared("Example-Bold.ttf", 700)],
      { displayName: "Font 0", family },
      expect.any(AbortSignal),
    );
    expect(context.section.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe(
      "Unsaved name",
    );
    button(context.section, "Add font styles").click();
    button(context.section, "Font library").click();
    expect(context.section.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe(
      "Unsaved name",
    );
    expect(context.renamed).not.toHaveBeenCalled();
  } finally {
    context.dispose();
  }
});

it("finishes an accepted name write after closing without restoring disposed controls", async () => {
  const context = fixture(1);
  let finish!: () => void;
  context.renamed.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  button(context.section, "Edit Font 0").click();
  changeName(context.section, "Personal font");
  button(context.section, "Save font name").click();
  expect(button(context.section, "Font library").disabled).toBe(true);
  context.dispose();
  finish();
  await vi.waitFor(() => expect(context.changed).toHaveBeenCalledOnce());
  expect(context.section.textContent).toBe("");
});

it("returns to the original variant on a later library page after cancelling its import", () => {
  const context = fixture(10);
  const faces = context.library
    .list()
    .map((face, index, all) =>
      index === 9
        ? { ...face, family: all[0]!.family, displayName: all[0]!.displayName, weight: 700 }
        : face,
    );
  vi.spyOn(context.library, "list").mockReturnValue(faces);
  try {
    button(context.section, "Next fonts").click();
    button(context.section, "Edit Font 0").click();
    button(context.section, "Add font styles").click();
    button(context.section, "Font library").click();
    button(context.section, "Font library").click();
    expect(document.activeElement).toBe(button(context.section, "Edit Font 0"));
    expect(context.renamed).not.toHaveBeenCalled();
  } finally {
    context.dispose();
  }
});
