// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { FontOptionPreviews } from "../../../../src/obsidian/fonts/font-option-previews";
import type { FontPreviewSource } from "../../../../src/obsidian/fonts/font-preview-source";
import { serializeFontStylesheet } from "../../../../src/persistence/serialization/output/text-fonts";
import {
  installFontPreviewHost,
  previewFontResource,
} from "../../../fixtures/obsidian/native-font-preview";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function fixture(source: FontPreviewSource = {}, owner = document) {
  const host = installFontPreviewHost(owner);
  const pool = new FontOptionPreviews({
    document: owner,
    scheduler: new TestWorkScheduler(),
    ...source,
  });
  cleanups.push(() => {
    pool.dispose();
    host.restore();
  });
  const label = (): HTMLElement => owner.body.appendChild(owner.createElement("span"));
  return { pool, host, label };
}

it("previews all builtins and custom fonts without changing the document's embedded resources", async () => {
  const custom = await previewFontResource("inter", 700, "italic");
  const documentFont = { ...(await previewFontResource()), family: "inter" };
  const resources = Object.freeze([documentFont]);
  const before = serializeFontStylesheet(resources);
  const resolve = vi.fn(async () => custom);
  const context = fixture({ resources: () => resources, library: { resolve } });
  const families = ["inter", "source-serif", "caveat", "jetbrains-mono", custom.family];
  const labels = families.map((family) => {
    const label = context.label();
    context.pool.acquire(label, family);
    return label;
  });
  await Promise.all(labels.map((label) => context.host.ready(label)));
  expect(context.host.retained.size).toBe(5);
  expect(context.host.maximumLoading()).toBe(1);
  expect(resolve).toHaveBeenCalledOnce();
  expect(labels.every((label) => label.style.fontFamily.startsWith("inkbook-preview-"))).toBe(true);
  expect(serializeFontStylesheet(resources)).toBe(before);
  expect(before.match(/data:font\//g)).toHaveLength(1);
  context.pool.dispose();
  expect(context.host.retained.size).toBe(0);
  expect(labels.every((label) => label.style.fontFamily === "")).toBe(true);
});

it("admits at most eight real faces and admits a deferred visible face after release", async () => {
  const resources = await Promise.all([
    ...["inter", "source-serif"].flatMap((family) =>
      [400, 700].flatMap((weight) =>
        ["normal", "italic"].map((style) =>
          previewFontResource(family, weight, style as "normal" | "italic"),
        ),
      ),
    ),
    previewFontResource("jetbrains-mono"),
  ]);
  const context = fixture({ resources: () => resources });
  const leases = resources.map((resource) => {
    const element = context.label();
    return { element, release: context.pool.acquire(element, resource.family) };
  });
  await Promise.all(leases.slice(0, 8).map(({ element }) => context.host.ready(element)));
  expect(context.host.created).toHaveLength(8);
  expect(context.host.retained.size).toBe(8);
  leases[0]!.release();
  await context.host.ready(leases[8]!.element);
  expect(context.host.created).toHaveLength(9);
  expect(context.host.retained.size).toBe(8);
  for (const lease of leases) lease.release();
  expect(context.host.retained.size).toBe(0);
});

it("shares a selected-label face and restores prior styles when the last lease is released", async () => {
  const resource = await previewFontResource();
  const alias = `custom-${"b".repeat(64)}`;
  const resolve = vi.fn(async () => undefined);
  const context = fixture({
    resources: () => [resource],
    library: { match: () => ({ ...resource, family: alias }), resolve },
  });
  const selected = context.label();
  selected.style.setProperty("font-family", "serif", "important");
  const option = context.label();
  const releaseSelected = context.pool.acquire(selected, resource.family);
  const releaseOption = context.pool.acquire(option, resource.family);
  const aliasLabel = context.label();
  const releaseAlias = context.pool.acquire(aliasLabel, alias);
  await context.host.ready(option);
  await context.host.ready(aliasLabel);
  expect(context.host.created).toHaveLength(1);
  expect(resolve).not.toHaveBeenCalled();
  releaseOption();
  expect(context.host.retained.size).toBe(1);
  releaseSelected();
  expect(selected.style.fontFamily).toBe("serif");
  expect(selected.style.getPropertyPriority("font-family")).toBe("important");
  expect(context.host.retained.size).toBe(1);
  releaseAlias();
  expect(context.host.retained.size).toBe(0);
});

it("cancels publication when closed during a native load and uses the owning pop-out window", async () => {
  const frame = document.body.appendChild(document.createElement("iframe"));
  const owner = frame.contentDocument!;
  const resource = await previewFontResource();
  const context = fixture({ resources: () => [resource] }, owner);
  let finish!: () => void;
  context.host.defer(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const label = context.label();
  context.pool.acquire(label, resource.family);
  await vi.waitFor(() => expect(context.host.created).toHaveLength(1));
  expect(() => context.pool.acquire(document.createElement("span"), resource.family)).toThrow(
    "window mismatch",
  );
  context.pool.dispose();
  finish();
  await vi.waitFor(() => expect(context.host.loading()).toBe(0));
  expect(context.host.retained.size).toBe(0);
  expect(label.style.fontFamily).toBe("");
});
