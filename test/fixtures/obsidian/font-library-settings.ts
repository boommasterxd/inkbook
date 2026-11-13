import { vi } from "vitest";
import { createEnglishLocalization } from "../../../src/domain/localization";
import { mountFontLibraryContent } from "../../../src/obsidian/settings/fonts/font-library-settings";
import type {
  LibraryFontFace,
  VaultFontLibrary,
} from "../../../src/obsidian/fonts/vault-font-library";
import type { PreparedLibraryFontFace } from "../../../src/obsidian/fonts/font-import-staging";
import { TestWorkScheduler } from "../persistence/work-scheduler";
import { preparedLibraryFont as prepared } from "./prepared-library-font";
import { expect } from "vitest";

export function fontLibrarySettingsFixture(count: number) {
  let faces: LibraryFontFace[] = Array.from({ length: count }, (_, index) => ({
    id: index.toString(16).padStart(64, "0"),
    family: `custom-${index.toString(16).padStart(64, "0")}`,
    path: `Inkbook Fonts/${index.toString(16).padStart(64, "0")}.ttf`,
    displayName: `Font ${String(index)}`,
    weight: 400,
    style: "normal",
  }));
  const prepare = vi.fn(async (_bytes: Uint8Array, name: string) =>
    prepared(name, name.includes("Bold") ? 700 : 400),
  );
  const commit = vi.fn(
    async (_files: readonly PreparedLibraryFontFace[], _options: unknown) => faces,
  );
  const release = vi.fn();
  const removed = vi.fn(async (id: string) => {
    faces = faces.filter((face) => face.id !== id);
  });
  const renamed = vi.fn(async (family: string, displayName: string) => {
    faces = faces.map((face) => (face.family === family ? { ...face, displayName } : face));
  });
  const changed = vi.fn();
  const confirmRemove = vi.fn(async (_face: LibraryFontFace, _signal: AbortSignal) => true);
  const library = {
    list: () => faces,
    prepareImport: prepare,
    commitImport: commit,
    releasePrepared: release,
    remove: removed,
    renameFamily: renamed,
    resource: vi.fn(async () => prepared().resource),
  } as unknown as VaultFontLibrary;
  const section = document.body.createDiv();
  const dispose = mountFontLibraryContent(section, {
    localization: createEnglishLocalization(),
    library,
    changed,
    confirmRemove,
    scheduler: new TestWorkScheduler(),
    readMotion: () => "reduced",
  });
  return {
    section,
    library,
    prepare,
    commit,
    release,
    removed,
    renamed,
    changed,
    confirmRemove,
    dispose,
  };
}

export function button(container: HTMLElement, label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  if (result === undefined) throw new Error(`Missing button: ${label}`);
  return result;
}

export function displayedFonts(container: HTMLElement): string[] {
  return [
    ...container.querySelectorAll('[data-inkbook-setting-identity^="font:"] .setting-item-name'),
  ].map((element) => element.textContent ?? "");
}

export function selectFiles(container: HTMLElement, files = [file("Example.ttf")]): void {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change"));
}

export function file(name: string) {
  return { name, size: 1, arrayBuffer: vi.fn(async () => new Uint8Array([1]).buffer) };
}

export async function checkStep(
  context: ReturnType<typeof fontLibrarySettingsFixture>,
): Promise<void> {
  button(context.section, "Add font").click();
  selectFiles(context.section);
  await vi.waitFor(() => expect(button(context.section, "Next").disabled).toBe(false));
  button(context.section, "Next").click();
}
