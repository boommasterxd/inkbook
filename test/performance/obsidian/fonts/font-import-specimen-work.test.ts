// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import * as fontResources from "../../../../src/persistence/fonts/font-resources";
import { vaultFontLibraryFixture } from "../../../fixtures/obsidian/vault-font-library";
import { fontCssFamily } from "../../../../src/domain/text/font-family";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import {
  button,
  file,
  fontLibrarySettingsFixture,
  selectFiles,
} from "../../../fixtures/obsidian/font-library-settings";
import {
  installFontPreviewHost,
  previewFontResource,
} from "../../../fixtures/obsidian/native-font-preview";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";

it("publishes staged bytes without another Base64 pass and isolates the preview from the vault binary", async () => {
  const vault = await vaultFontLibraryFixture("caveat-variable.ttf");
  const prepared = await vault.library.prepareImport(vault.bytes, "Caveat.ttf");
  const decode = vi.spyOn(fontResources, "decodeFontResource");
  const host = installFontPreviewHost(document, (buffer) => new Uint8Array(buffer).fill(0));
  try {
    const native = await vault.library.previewPrepared(prepared, {
      document,
      scheduler: new TestWorkScheduler(),
      signal: new AbortController().signal,
    });
    expect(host.created[0]?.bytes).toBe(vault.bytes.byteLength);
    expect(host.retained.size).toBe(1);
    expect(decode).not.toHaveBeenCalled();
    native?.dispose();
    const [entry] = await vault.library.commitImport([prepared], { displayName: "Caveat" });
    expect(new Uint8Array(vault.data.get(entry!.path)!)).toEqual(vault.bytes);
    expect(host.retained.size).toBe(0);
  } finally {
    decode.mockRestore();
    host.restore();
    vault.dispose();
  }
});

it("warms one native face, replaces pending styles with the latest choice, and releases on close", async () => {
  installObsidianDomHelpers();
  const resources = await Promise.all([
    previewFontResource(),
    previewFontResource("inter", 700),
    previewFontResource("inter", 400, "italic"),
  ]);
  const context = fontLibrarySettingsFixture(0);
  const host = installFontPreviewHost(document);
  const files = resources.map((resource, index) => {
    const input = file(`Inter-${index}.woff2`);
    context.prepare.mockResolvedValueOnce({
      id: resource.id,
      familyName: "Inter",
      fileName: input.name,
      resource,
      style: resource.style,
      weight: resource.weight,
    });
    return input;
  });
  const holdLoad = () => {
    let finish!: () => void;
    host.defer(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    return finish;
  };
  let finishLoad = holdLoad();
  try {
    button(context.section, "Add font").click();
    selectFiles(context.section, files);
    await vi.waitFor(() => expect(host.loading()).toBe(1));
    expect(context.section.querySelector('[aria-label="Preview"]')).toBeNull();
    button(context.section, "Next").click();
    const style = context.section.querySelector("select")!;
    style.focus();
    for (const resource of resources.slice(1)) {
      style.value = resource.id;
      style.dispatchEvent(new Event("change"));
    }
    expect(document.activeElement).toBe(style);
    expect(host.created).toHaveLength(1);
    expect(host.retained.size).toBe(0);
    host.defer(Promise.resolve());
    finishLoad();
    const specimen = context.section.querySelector<HTMLElement>('[aria-label="Preview"]')!;
    const sample = specimen.querySelector<HTMLElement>(".inkbook-font-import-specimen-sample")!;
    await vi.waitFor(() => expect(sample.hidden).toBe(false));
    expect(sample.style.fontFamily).toBe(fontCssFamily(`preview-${resources[2].id}`));
    expect(host.created).toHaveLength(2);
    expect(host.maximumLoading()).toBe(1);
    expect(host.retained.size).toBe(1);
    finishLoad = holdLoad();
    style.value = resources[0].id;
    style.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(host.loading()).toBe(1));
    context.dispose();
    finishLoad();
    await vi.waitFor(() => expect(host.loading()).toBe(0));
    expect(host.created).toHaveLength(3);
    expect(host.maximumLoading()).toBe(1);
    expect(host.retained.size).toBe(0);
  } finally {
    finishLoad();
    context.dispose();
    host.restore();
    context.section.remove();
  }
});
