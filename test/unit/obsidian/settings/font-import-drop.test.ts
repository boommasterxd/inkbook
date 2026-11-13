// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { installFontSettingsLifecycle } from "../../../fixtures/obsidian/font-settings-lifecycle";
import { createEnglishLocalization } from "../../../../src/domain/localization";
import {
  FontImportError,
  type PreparedLibraryFontFace,
} from "../../../../src/obsidian/fonts/font-import-staging";
import type { VaultFontLibrary } from "../../../../src/obsidian/fonts/vault-font-library";
import { FontImportWizard } from "../../../../src/obsidian/settings/fonts/font-import-wizard";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { preparedLibraryFont as prepared } from "../../../fixtures/obsidian/prepared-library-font";

installFontSettingsLifecycle();

function fixture() {
  const prepare = vi.fn(async (_bytes: Uint8Array, name: string, _signal: AbortSignal) =>
    prepared(name, name.includes("Bold") ? 700 : 400),
  );
  const commit = vi.fn(async () => []);
  const release = vi.fn();
  const imported = vi.fn();
  const back = vi.fn();
  const section = document.body.createDiv();
  const wizard = new FontImportWizard(section, {
    localization: createEnglishLocalization(),
    library: {
      list: () => [],
      prepareImport: prepare,
      commitImport: commit,
      releasePrepared: release,
    } as unknown as VaultFontLibrary,
    scheduler: new TestWorkScheduler(),
    readMotion: () => "reduced",
    changed: vi.fn(),
    confirmRemove: vi.fn(async () => true),
    imported,
    back,
  });
  return { section, wizard, prepare, commit, release, imported, back };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

function file(name: string, size = 1) {
  const result = new File([new Uint8Array([1])], name);
  const arrayBuffer = vi.fn(async () => new Uint8Array([1]).buffer);
  Object.defineProperty(result, "size", { value: size });
  return Object.assign(result, { arrayBuffer, read: arrayBuffer });
}

function drag(
  target: Element,
  type: string,
  files: readonly File[] = [],
  options: { readonly types?: readonly string[]; readonly relatedTarget?: EventTarget } = {},
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: { files, types: options.types ?? ["Files"], dropEffect: "none" } },
    relatedTarget: { value: options.relatedTarget ?? null },
  });
  target.dispatchEvent(event);
  return event;
}

function holdPreparation(context: ReturnType<typeof fixture>) {
  let complete!: (face: PreparedLibraryFontFace) => void;
  context.prepare.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  return (face: PreparedLibraryFontFace) => complete(face);
}

it("reviews every dropped style and writes only after explicit confirmation", async () => {
  const context = fixture();
  const regular = file("Example.ttf");
  const bold = file("Example-Bold.ttf");
  const hostDrop = vi.fn();
  context.section.addEventListener("drop", hostDrop);
  try {
    const card = button(context.section, "Choose font files or drop files here");
    expect(card.getAttribute("aria-label")).toBe(card.textContent?.replace(/\s+/g, " ").trim());
    card.focus();
    expect(document.activeElement).toBe(card);
    const input = context.section.querySelector<HTMLInputElement>('input[type="file"]')!;
    const choose = vi.spyOn(input, "click");
    card.click();
    expect(choose).toHaveBeenCalledOnce();
    const dropped = drag(card, "drop", [regular, bold]);
    expect(dropped.defaultPrevented).toBe(true);
    expect(hostDrop).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(button(context.section, "Next").disabled).toBe(false));
    expect(context.prepare.mock.calls.map(([, name]) => name)).toEqual([
      "Example.ttf",
      "Example-Bold.ttf",
    ]);
    expect(regular.read).toHaveBeenCalledOnce();
    expect(bold.read).toHaveBeenCalledOnce();
    expect(context.commit).not.toHaveBeenCalled();
    button(context.section, "Next").click();
    expect(context.section.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe(
      "Example",
    );
    button(context.section, "Next").click();
    expect(context.section.textContent).toContain("Example-Bold.ttf");
    expect(context.commit).not.toHaveBeenCalled();
    button(context.section, "Add font").click();
    await vi.waitFor(() => expect(context.imported).toHaveBeenCalledOnce());
    expect(context.commit).toHaveBeenCalledExactlyOnceWith(
      [prepared("Example.ttf"), prepared("Example-Bold.ttf", 700)],
      { displayName: "Example" },
      expect.any(AbortSignal),
    );
  } finally {
    context.wizard.dispose();
  }
});

it("keeps file drag feedback within the card and ignores text and URL drops", () => {
  const context = fixture();
  const hostDrop = vi.fn();
  context.section.addEventListener("drop", hostDrop);
  try {
    const card = button(context.section, "Choose font files or drop files here");
    const child = card.querySelector("span")!;
    drag(card, "dragenter");
    expect(card.dataset["inkbookDropActive"]).toBe("true");
    drag(child, "dragenter");
    drag(card, "dragleave", [], { relatedTarget: child });
    expect(card.dataset["inkbookDropActive"]).toBe("true");
    expect(drag(child, "dragover").defaultPrevented).toBe(true);
    drag(child, "dragleave", [], { relatedTarget: context.section });
    expect(card.dataset["inkbookDropActive"]).not.toBe("true");
    drag(card, "dragenter");
    drag(card, "drop");
    expect(card.dataset["inkbookDropActive"]).not.toBe("true");
    for (const type of ["text/plain", "text/uri-list"]) {
      drag(card, "dragenter", [], { types: [type] });
      expect(card.dataset["inkbookDropActive"]).not.toBe("true");
      expect(drag(card, "drop", [], { types: [type] }).defaultPrevented).toBe(true);
    }
    expect(hostDrop).not.toHaveBeenCalled();
    expect(context.prepare).not.toHaveBeenCalled();
    expect(context.commit).not.toHaveBeenCalled();
  } finally {
    context.wizard.dispose();
  }
});

it("ignores a second drop while the first batch is being prepared", async () => {
  const context = fixture();
  const complete = holdPreparation(context);
  try {
    drag(button(context.section, "Choose font files or drop files here"), "drop", [
      file("Example.ttf"),
    ]);
    await vi.waitFor(() => expect(context.prepare).toHaveBeenCalledOnce());
    const card = button(context.section, "Choose font files or drop files here");
    expect(card.disabled).toBe(true);
    const ignored = file("Example-Bold.ttf");
    expect(drag(card, "drop", [ignored]).defaultPrevented).toBe(true);
    expect(ignored.read).not.toHaveBeenCalled();
    complete(prepared());
    await vi.waitFor(() => expect(button(context.section, "Next").disabled).toBe(false));
    expect(context.prepare).toHaveBeenCalledOnce();
    expect(context.commit).not.toHaveBeenCalled();
  } finally {
    context.wizard.dispose();
  }
});

it("rejects oversized and invalid dropped batches and accepts a corrected drop", async () => {
  const context = fixture();
  const huge = file("Huge.ttf", 9 * 1024 * 1024);
  const regular = file("Example.ttf");
  try {
    drag(button(context.section, "Choose font files or drop files here"), "drop", [regular, huge]);
    await vi.waitFor(() => expect(context.section.textContent).toContain("larger than 8 MiB"));
    expect(regular.read).not.toHaveBeenCalled();
    expect(huge.read).not.toHaveBeenCalled();
    expect(context.prepare).not.toHaveBeenCalled();
    context.prepare
      .mockResolvedValueOnce(prepared())
      .mockRejectedValueOnce(new FontImportError("invalid-font", "Invalid font"));
    drag(button(context.section, "Choose font files or drop files here"), "drop", [
      regular,
      file("Broken.ttf"),
    ]);
    await vi.waitFor(() => expect(context.section.textContent).toContain("not a supported font"));
    expect(button(context.section, "Next").disabled).toBe(true);
    expect(context.release).toHaveBeenCalledExactlyOnceWith(prepared());
    drag(button(context.section, "Choose font files or drop files here"), "drop", [regular]);
    await vi.waitFor(() => expect(button(context.section, "Next").disabled).toBe(false));
    expect(context.section.querySelector(".inkbook-font-import-files")?.textContent).toContain(
      "Example.ttf",
    );
    expect(context.section.textContent).not.toContain("not a supported font");
    expect(context.commit).not.toHaveBeenCalled();
  } finally {
    context.wizard.dispose();
  }
});

it("aborts a dropped import and releases its late prepared result after teardown", async () => {
  const context = fixture();
  const complete = holdPreparation(context);
  drag(button(context.section, "Choose font files or drop files here"), "drop", [
    file("Example.ttf"),
  ]);
  await vi.waitFor(() => expect(context.prepare).toHaveBeenCalledOnce());
  const signal = context.prepare.mock.calls[0]![2];
  context.wizard.dispose();
  expect(signal.aborted).toBe(true);
  complete(prepared());
  await vi.waitFor(() => expect(context.release).toHaveBeenCalledExactlyOnceWith(prepared()));
  expect(context.section.textContent).toBe("");
  expect(context.commit).not.toHaveBeenCalled();
  expect(context.imported).not.toHaveBeenCalled();
});
