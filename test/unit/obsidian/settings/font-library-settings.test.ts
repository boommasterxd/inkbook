// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  FontImportError,
  type PreparedLibraryFontFace,
} from "../../../../src/obsidian/fonts/font-import-staging";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { preparedLibraryFont as prepared } from "../../../fixtures/obsidian/prepared-library-font";
import {
  fontLibrarySettingsFixture as fixture,
  button,
  displayedFonts,
  selectFiles,
  file,
  checkStep,
} from "../../../fixtures/obsidian/font-library-settings";
import { loadNativeFontPreview } from "../../../../src/obsidian/fonts/native-font-preview";

vi.mock("../../../../src/obsidian/fonts/native-font-preview", async (original) => ({
  ...(await original<typeof import("../../../../src/obsidian/fonts/native-font-preview")>()),
  loadNativeFontPreview: vi.fn(async () => undefined),
}));
beforeEach(() => {
  installObsidianDomHelpers();
  vi.mocked(loadNativeFontPreview).mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("bounds rendered rows while allowing all pages and non-destructive removal", async () => {
  const context = fixture(17);
  try {
    expect(displayedFonts(context.section)).toContain("Font 0");
    expect(displayedFonts(context.section)).not.toContain("Font 8");
    expect(context.section.textContent).not.toContain("keeps its source file");
    button(context.section, "Next fonts").click();
    expect(displayedFonts(context.section)).toContain("Font 8");
    const remove = button(context.section, "Remove Font 8 from library");
    remove.focus();
    remove.click();
    await vi.waitFor(() => expect(context.changed).toHaveBeenCalledOnce());
    expect(context.removed).toHaveBeenCalledWith("8".padStart(64, "0"));
    expect(displayedFonts(context.section)).not.toContain("Font 8");
    expect(document.activeElement).toBe(button(context.section, "Add font"));
    button(context.section, "Previous fonts").click();
    expect(displayedFonts(context.section)).toContain("Font 0");
    expect(displayedFonts(context.section)).not.toContain("Font 9");
  } finally {
    context.dispose();
  }
});

it("cancels removal without writing and keeps the selected style focused", async () => {
  const context = fixture(1);
  context.confirmRemove.mockResolvedValueOnce(false);
  try {
    const remove = button(context.section, "Remove Font 0 from library");
    remove.focus();
    remove.click();
    await vi.waitFor(() => expect(context.confirmRemove).toHaveBeenCalledOnce());
    expect(document.activeElement).toBe(remove);
    expect(context.removed).not.toHaveBeenCalled();
    expect(context.changed).not.toHaveBeenCalled();
  } finally {
    context.dispose();
  }
});

it("aborts pending confirmation on disposal and ignores a late confirmation", async () => {
  const context = fixture(1);
  let confirm!: (value: boolean) => void;
  context.confirmRemove.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        confirm = resolve;
      }),
  );
  const remove = button(context.section, "Remove Font 0 from library");
  remove.click();
  remove.click();
  expect(context.confirmRemove).toHaveBeenCalledOnce();
  const signal = context.confirmRemove.mock.calls[0]![1];
  context.dispose();
  expect(signal.aborted).toBe(true);
  confirm(true);
  await Promise.resolve();
  expect(context.removed).not.toHaveBeenCalled();
  expect(context.changed).not.toHaveBeenCalled();
});

it("retries a failed confirmed removal without opening another confirmation", async () => {
  const context = fixture(1);
  const dispose = vi.fn();
  vi.mocked(loadNativeFontPreview).mockResolvedValueOnce({
    family: "retry-preview",
    weight: 400,
    style: "normal",
    bytes: 1,
    decodedBytes: 1,
    dispose,
  });
  context.removed.mockRejectedValueOnce(new Error("Storage unavailable"));
  try {
    button(context.section, "Preview Font 0").click();
    await vi.waitFor(() =>
      expect(context.section.querySelector<HTMLElement>("[role='region']")?.hidden).toBe(false),
    );
    const panel = context.section.querySelector("[role='region']")!;
    button(context.section, "Remove Font 0 from library").click();
    await vi.waitFor(() => expect(button(context.section, "Retry").hidden).toBe(false));
    expect(dispose).toHaveBeenCalledOnce();
    expect(panel.isConnected).toBe(false);
    expect(context.section.querySelector("[role='region']")).toBeNull();
    expect(context.changed).not.toHaveBeenCalled();
    button(context.section, "Retry").click();
    await vi.waitFor(() => expect(context.changed).toHaveBeenCalledOnce());
    expect(context.confirmRemove).toHaveBeenCalledOnce();
    expect(context.removed).toHaveBeenCalledTimes(2);
    expect(displayedFonts(context.section)).toEqual([]);
  } finally {
    context.dispose();
  }
});

it("toggles a compact preview inside its own row while preserving the list and focus", async () => {
  const context = fixture(2);
  const native = {
    family: "library-preview",
    weight: 400,
    style: "normal" as const,
    bytes: 1,
    decodedBytes: 1,
    dispose: vi.fn(),
  };
  vi.mocked(loadNativeFontPreview).mockResolvedValue(native);
  try {
    const rows = [
      ...context.section.querySelectorAll<HTMLElement>('[data-inkbook-setting-identity^="font:"]'),
    ];
    expect(context.section.querySelector("select")).toBeNull();
    const toggle = button(rows[0]!, "Preview Font 0");
    toggle.focus();
    toggle.click();
    await vi.waitFor(() =>
      expect(rows[0]!.querySelector<HTMLElement>(".inkbook-font-library-preview")?.hidden).toBe(
        false,
      ),
    );
    expect(rows[0]!.querySelector(".inkbook-font-sample")?.textContent).toContain(
      "The quick brown fox",
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(panel?.hidden).toBe(false);
    expect(rows[0]!.contains(panel)).toBe(true);
    expect(document.activeElement).toBe(toggle);
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(context.section.querySelector(".inkbook-font-sample")).toBeNull();
    expect(native.dispose).toHaveBeenCalledOnce();
    expect(displayedFonts(context.section)).toEqual(["Font 0", "Font 1"]);
    expect(context.changed).not.toHaveBeenCalled();
  } finally {
    context.dispose();
  }
});

it("prepares multiple styles without writes and commits the reviewed name once", async () => {
  const context = fixture(0);
  try {
    button(context.section, "Add font").click();
    const input = context.section.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.multiple).toBe(true);
    expect(input.accept).toBe(".ttf,.otf,.woff,.woff2");
    selectFiles(context.section, [file("Example.ttf"), file("Example-Bold.ttf")]);
    await vi.waitFor(() => expect(context.prepare).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(button(context.section, "Next").disabled).toBe(false));
    expect(context.commit).not.toHaveBeenCalled();
    button(context.section, "Next").click();
    const name = context.section.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(name.value).toBe("Example");
    const previewStyle = [...context.section.querySelectorAll("label")]
      .find((label) => label.textContent?.startsWith("Style to preview"))!
      .querySelector("select")!;
    previewStyle.value = prepared("Example-Bold.ttf", 700).id;
    previewStyle.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(loadNativeFontPreview).toHaveBeenLastCalledWith(
        prepared("Example-Bold.ttf", 700).resource,
        expect.any(Object),
      ),
    );
    const currentName = context.section.querySelector<HTMLInputElement>('input[type="text"]')!;
    currentName.value = "My handwriting";
    currentName.dispatchEvent(new Event("input"));
    button(context.section, "Next").click();
    expect(context.section.textContent).toContain("My handwriting");
    expect(context.commit).not.toHaveBeenCalled();
    button(context.section, "Add font").click();
    await vi.waitFor(() => expect(context.changed).toHaveBeenCalledOnce());
    expect(context.commit).toHaveBeenCalledOnce();
    expect(context.commit).toHaveBeenCalledWith(
      [prepared("Example.ttf"), prepared("Example-Bold.ttf", 700)],
      { displayName: "My handwriting" },
      expect.any(AbortSignal),
    );
    expect(context.section.textContent).toContain("Font imported");
  } finally {
    context.dispose();
  }
});

it("keeps the draft when navigating back and releases it when returning to the library", async () => {
  const context = fixture(0);
  const native = {
    family: "preview",
    weight: 400,
    style: "normal" as const,
    bytes: 1,
    decodedBytes: 1,
    dispose: vi.fn(),
  };
  vi.mocked(loadNativeFontPreview).mockResolvedValueOnce(native);
  try {
    await checkStep(context);
    await vi.waitFor(() => expect(loadNativeFontPreview).toHaveBeenCalled());
    const name = context.section.querySelector<HTMLInputElement>('input[type="text"]')!;
    name.value = "Personal font";
    name.dispatchEvent(new Event("input"));
    button(context.section, "Next").click();
    button(context.section, "Back").click();
    expect(context.section.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe(
      "Personal font",
    );
    button(context.section, "Back").click();
    expect(context.section.textContent).toContain("Example.ttf");
    expect(context.prepare).toHaveBeenCalledOnce();
    button(context.section, "Font library").click();
    expect(context.release).toHaveBeenCalledWith(prepared());
    expect(native.dispose).toHaveBeenCalledOnce();
    expect(context.commit).not.toHaveBeenCalled();
    expect(context.changed).not.toHaveBeenCalled();
  } finally {
    context.dispose();
  }
});

it("previews the retained style and adopts the replacement name after clearing a draft", async () => {
  const context = fixture(0);
  const regular = prepared();
  const bold = prepared("Example-Bold.ttf", 700);
  const replacement = { ...prepared("Replacement.ttf"), familyName: "Replacement" };
  try {
    button(context.section, "Add font").click();
    selectFiles(context.section, [file("Example.ttf"), file("Example-Bold.ttf")]);
    await vi.waitFor(() => expect(button(context.section, "Next").disabled).toBe(false));
    button(context.section, "Next").click();
    const previewStyle = context.section.querySelector("select")!;
    previewStyle.value = bold.id;
    previewStyle.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(loadNativeFontPreview).toHaveBeenLastCalledWith(bold.resource, expect.any(Object)),
    );
    button(context.section, "Back").click();
    button(context.section, "Remove Example-Bold.ttf from selection").click();
    button(context.section, "Next").click();
    expect(context.section.querySelector("select")).toBeNull();
    expect(loadNativeFontPreview).toHaveBeenLastCalledWith(regular.resource, expect.any(Object));
    expect(context.section.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe(
      "Example",
    );
    button(context.section, "Back").click();
    button(context.section, "Remove Example.ttf from selection").click();
    expect(button(context.section, "Next").disabled).toBe(true);
    context.prepare.mockResolvedValueOnce(replacement);
    selectFiles(context.section, [file("Replacement.ttf")]);
    await vi.waitFor(() => expect(button(context.section, "Next").disabled).toBe(false));
    button(context.section, "Next").click();
    expect(context.section.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe(
      "Replacement",
    );
    expect(loadNativeFontPreview).toHaveBeenLastCalledWith(
      replacement.resource,
      expect.any(Object),
    );
    expect(context.release).toHaveBeenCalledWith(bold);
    expect(context.release).toHaveBeenCalledWith(regular);
    expect(context.commit).not.toHaveBeenCalled();
  } finally {
    context.dispose();
  }
});

it("uses an existing font name and recovers a failed final write without preparing again", async () => {
  const context = fixture(1);
  context.commit.mockRejectedValueOnce(new Error("Storage unavailable"));
  try {
    await checkStep(context);
    const select = [...context.section.querySelectorAll("label")]
      .find((label) => label.textContent?.startsWith("Add to existing font"))!
      .querySelector("select")!;
    select.value = context.library.list()[0]!.family;
    select.dispatchEvent(new Event("change"));
    const name = context.section.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(name.disabled).toBe(true);
    expect(name.value).toBe("Font 0");
    button(context.section, "Next").click();
    button(context.section, "Add font").click();
    await vi.waitFor(() => expect(context.section.textContent).toContain("could not be imported"));
    expect(context.changed).not.toHaveBeenCalled();
    button(context.section, "Add font").click();
    await vi.waitFor(() => expect(context.changed).toHaveBeenCalledOnce());
    expect(context.prepare).toHaveBeenCalledOnce();
    expect(context.commit).toHaveBeenCalledTimes(2);
    expect(context.commit).toHaveBeenLastCalledWith(
      [prepared()],
      { displayName: "Font 0", family: context.library.list()[0]!.family },
      expect.any(AbortSignal),
    );
  } finally {
    context.dispose();
  }
});

it("rejects oversized selections before reading any bytes", async () => {
  const context = fixture(0);
  const huge = { ...file("Huge.ttf"), size: 9 * 1024 * 1024 };
  try {
    button(context.section, "Add font").click();
    selectFiles(context.section, [huge]);
    await vi.waitFor(() => expect(context.section.textContent).toContain("larger than 8 MiB"));
    expect(huge.arrayBuffer).not.toHaveBeenCalled();
    expect(context.prepare).not.toHaveBeenCalled();
    expect(context.commit).not.toHaveBeenCalled();
    expect(button(context.section, "Next").disabled).toBe(true);
  } finally {
    context.dispose();
  }
});

it("releases a late prepared result after disposal without committing it", async () => {
  const context = fixture(0);
  let complete!: (face: PreparedLibraryFontFace) => void;
  context.prepare.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  button(context.section, "Add font").click();
  selectFiles(context.section);
  await vi.waitFor(() => expect(context.prepare).toHaveBeenCalledOnce());
  context.dispose();
  complete(prepared());
  await vi.waitFor(() => expect(context.release).toHaveBeenCalledWith(prepared()));
  expect(context.commit).not.toHaveBeenCalled();
  expect(context.changed).not.toHaveBeenCalled();
  expect(context.section.textContent).toBe("");
});

it("does not prepare bytes whose file read completes after closing", async () => {
  const context = fixture(0);
  let complete!: (bytes: ArrayBuffer) => void;
  const reading = new Promise<ArrayBuffer>((resolve) => {
    complete = resolve;
  });
  button(context.section, "Add font").click();
  selectFiles(context.section, [
    { name: "Example.ttf", size: 1, arrayBuffer: vi.fn(() => reading) },
  ]);
  context.dispose();
  complete(new Uint8Array([1]).buffer);
  await reading;
  await Promise.resolve();
  expect(context.prepare).not.toHaveBeenCalled();
  expect(context.commit).not.toHaveBeenCalled();
  expect(context.changed).not.toHaveBeenCalled();
});

it("keeps invalid font files out of review and accepts a corrected selection", async () => {
  const context = fixture(0);
  context.prepare.mockRejectedValueOnce(new FontImportError("invalid-font", "Invalid font"));
  try {
    button(context.section, "Add font").click();
    selectFiles(context.section, [file("Broken.ttf")]);
    await vi.waitFor(() => expect(context.section.textContent).toContain("not a supported font"));
    expect(button(context.section, "Next").disabled).toBe(true);
    expect(context.commit).not.toHaveBeenCalled();
    selectFiles(context.section);
    await vi.waitFor(() => expect(button(context.section, "Next").disabled).toBe(false));
    button(context.section, "Next").click();
    expect(context.section.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe(
      "Example",
    );
    expect(context.changed).not.toHaveBeenCalled();
  } finally {
    context.dispose();
  }
});
