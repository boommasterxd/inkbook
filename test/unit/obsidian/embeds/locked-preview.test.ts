// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActiveScenePreviewHandoff } from "../../../../src/obsidian/embeds/active-scene-handoff";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { createSnapshot } from "../../persistence/serialization/fixtures";

import { Platform } from "obsidian";
import * as previewBuilder from "../../../../src/obsidian/embeds/safe-preview-builder";

import { createInkbookLockedPreview } from "../../../../src/obsidian/embeds/locked-preview";
import { createHtmlElement, installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

const SAFE_PREVIEW_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><metadata></metadata></svg>';
const CONTENT_IDENTITY = { outputHash: "a".repeat(64), revision: 1 };

beforeEach(() => {
  installObsidianDomHelpers();
});

afterEach(() => {
  vi.restoreAllMocks();
  Platform.isAndroidApp = false;
  document.body.replaceChildren();
});

describe("locked preview platform treatment", () => {
  it("marks only Android activation buttons for host tap-surface neutralization", () => {
    Platform.isAndroidApp = true;
    const androidButton = createHtmlElement("button");
    const android = createInkbookLockedPreview(androidButton, {
      aspectRatio: 1,
      contentIdentity: CONTENT_IDENTITY,
      safeSvg: SAFE_PREVIEW_SVG,
    });

    Platform.isAndroidApp = false;
    const desktopButton = createHtmlElement("button");
    const desktop = createInkbookLockedPreview(desktopButton, {
      aspectRatio: 1,
      contentIdentity: CONTENT_IDENTITY,
      safeSvg: SAFE_PREVIEW_SVG,
    });

    expect(androidButton.classList.contains("inkbook-locked-preview-android")).toBe(true);
    expect(desktopButton.classList.contains("inkbook-locked-preview-android")).toBe(false);
    android.dispose();
    desktop.dispose();
  });
});

it("restores the latest deferred content before the preview handoff completes", async () => {
  const { button, preview } = await preparedPreview(true);
  preview.setDescriptor({
    aspectRatio: 2,
    contentIdentity: { ...CONTENT_IDENTITY, revision: 2 },
    safeSvg: SAFE_PREVIEW_SVG.replace("</svg>", '<path d="M0 0L1 1"/></svg>'),
  });
  const root = createHtmlElement("div");
  root.append(button);
  const handoff = new ActiveScenePreviewHandoff({
    root,
    container: createHtmlElement("div"),
    motion: "reduced",
    preview: button,
    refreshPreview: preview.refresh,
  });
  await preview.ensureReady();
  handoff.restorePreview();
  expect(button.hidden).toBe(false);
  expect(button.querySelector("path")).not.toBeNull();
  handoff.dispose();
  preview.dispose();
});

it.each(["descriptor", "dispose"] as const)(
  "ignores a source fetch completed after a superseding %s",
  async (operation) => {
    const serialized = serializeInkbookDocument(createSnapshot());
    if (!serialized.ok) throw new Error("Invalid test snapshot");
    let resolveFetch!: (response: Response) => void;
    const fetch = vi.spyOn(window, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const { button, preview } = await preparedPreview();
    const original = button.querySelector("svg");
    const pending = preview.setSource("app://old.svg");
    if (operation === "dispose") preview.dispose();
    else
      preview.setDescriptor({
        aspectRatio: 1,
        contentIdentity: CONTENT_IDENTITY,
        safeSvg: SAFE_PREVIEW_SVG,
      });
    resolveFetch(new Response(serialized.value.svg));
    await expect(pending).resolves.toBeUndefined();
    expect(button.querySelector("svg")).toBe(original);
    preview.dispose();
    await expect(preview.setSource("app://disposed.svg")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it.each([false, true])(
  "validates sources but deduplicates their DOM imports (hidden=%s)",
  async (hidden) => {
    const serialized = serializeInkbookDocument(createSnapshot());
    if (!serialized.ok) throw new Error("Invalid test snapshot");
    const fetch = vi
      .spyOn(window, "fetch")
      .mockImplementation(async () => new Response(serialized.value.svg));
    const parser = vi.spyOn(window.DOMParser.prototype, "parseFromString");
    const button = createHtmlElement("button");
    const preview = createInkbookLockedPreview(button, {
      aspectRatio: 1,
      contentIdentity: CONTENT_IDENTITY,
      safeSvg: SAFE_PREVIEW_SVG,
    });
    button.hidden = hidden;
    const identity = await preview.setSource("app://saved.svg");
    expect(identity).toEqual({
      outputHash: serialized.value.hash,
      revision: serialized.value.snapshot.revision,
    });
    await preview.setSource("app://saved-again.svg");
    await preview.ensureReady();
    expect(parser).not.toHaveBeenCalled();
    button.hidden = false;
    preview.refresh();
    expect(parser).not.toHaveBeenCalled();
    const current = button.querySelector("svg");
    fetch.mockResolvedValue(new Response("<svg/>"));
    await expect(preview.setSource("app://unsafe.svg")).rejects.toThrow("not safe SVG");
    expect(button.querySelector("svg")).toBe(current);
    expect(parser).not.toHaveBeenCalled();
    preview.dispose();
  },
);

it("pauses detached preparation during input and publishes only the latest descriptor", async () => {
  const { button, preview } = await preparedPreview(true);
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  preview.setBackgroundWait(() => paused);
  const creates = vi.spyOn(document, "createElementNS");
  for (const revision of [2, 3]) {
    preview.setDescriptor({
      aspectRatio: revision,
      contentIdentity: { ...CONTENT_IDENTITY, revision },
      safeSvg: SAFE_PREVIEW_SVG.replace("</svg>", `<path d="M0 0L${revision} ${revision}"/></svg>`),
    });
  }
  const ready = preview.ensureReady();
  await Promise.resolve();
  expect(creates).not.toHaveBeenCalled();
  expect(button.querySelector("path")).toBeNull();
  resume();
  await ready;
  expect(button.querySelector("path")).toBeNull();
  button.hidden = false;
  preview.refresh();
  expect(button.querySelector("path")?.getAttribute("d")).toBe("M0 0L3 3");
  expect(creates).toHaveBeenCalledTimes(2);
  preview.dispose();
});

it("settles lock readiness when disposed during an input pause without building stale DOM", async () => {
  const button = createHtmlElement("button");
  const preview = createInkbookLockedPreview(button, {
    aspectRatio: 1,
    contentIdentity: CONTENT_IDENTITY,
    safeSvg: SAFE_PREVIEW_SVG,
  });
  preview.setBackgroundWait(() => new Promise<void>(() => undefined));
  preview.setDescriptor({
    aspectRatio: 2,
    contentIdentity: { ...CONTENT_IDENTITY, revision: 2 },
    safeSvg: SAFE_PREVIEW_SVG,
  });
  const creates = vi.spyOn(document, "createElementNS");
  const ready = preview.ensureReady();
  preview.dispose();
  await ready;
  expect(creates).not.toHaveBeenCalled();
});

it("settles validated source identity while detached DOM preparation waits for input", async () => {
  const serialized = serializeInkbookDocument(createSnapshot());
  if (!serialized.ok) throw new Error("Invalid test snapshot");
  vi.spyOn(window, "fetch").mockImplementation(async () => new Response(serialized.value.svg));
  const { button, preview } = await preparedPreview();
  const original = button.querySelector("svg");
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const build = previewBuilder.createPreviewSvgAsync;
  vi.spyOn(previewBuilder, "createPreviewSvgAsync").mockImplementation((...args) => {
    preview.setBackgroundWait(() => paused);
    return build(...args);
  });
  const identity = await preview.setSource("app://saved.svg");
  expect(identity).toEqual({
    outputHash: serialized.value.hash,
    revision: serialized.value.snapshot.revision,
  });
  let ready = false;
  const pending = preview.ensureReady().then(() => {
    ready = true;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  expect(button.querySelector("svg")).toBe(original);
  resume();
  await pending;
  expect(button.querySelector("svg")).not.toBe(original);
  preview.dispose();
});

it("prepares initial content asynchronously with the current owning-window budget", async () => {
  const button = createHtmlElement("button");
  const budget = vi.fn(() => 2);
  const parser = vi.spyOn(window.DOMParser.prototype, "parseFromString");
  const creates = vi.spyOn(document, "createElementNS");
  const preview = createInkbookLockedPreview(
    button,
    {
      aspectRatio: 1,
      contentIdentity: CONTENT_IDENTITY,
      safeSvg: `<svg xmlns="http://www.w3.org/2000/svg">${'<path d="M0 0"/>'.repeat(64)}</svg>`,
    },
    budget,
  );
  expect(button.querySelector("svg")).toBeNull();
  expect(creates.mock.calls.some(([namespace]) => namespace === "http://www.w3.org/2000/svg")).toBe(
    false,
  );
  budget.mockReturnValue(1);
  await preview.ensureReady();
  expect(button.querySelectorAll("path")).toHaveLength(64);
  expect(budget).toHaveReturnedWith(1);
  expect(budget).not.toHaveReturnedWith(2);
  expect(parser).not.toHaveBeenCalled();
  preview.dispose();
});

async function preparedPreview(hidden = false) {
  const button = createHtmlElement("button");
  const preview = createInkbookLockedPreview(button, {
    aspectRatio: 1,
    contentIdentity: CONTENT_IDENTITY,
    safeSvg: SAFE_PREVIEW_SVG,
  });
  await preview.ensureReady();
  button.hidden = hidden;
  return { button, preview };
}

it("drains a newer hidden source received during lock preparation and retries failures", async () => {
  const button = createHtmlElement("button");
  button.hidden = true;
  let release!: () => void;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  const load = vi
    .fn<(source: string) => Promise<void>>()
    .mockReturnValueOnce(first)
    .mockRejectedValueOnce(new Error("fetch failed"))
    .mockResolvedValue(undefined);
  const ensure = vi.fn(async () => {});
  const root = createHtmlElement("div");
  const handoff = new ActiveScenePreviewHandoff({
    root,
    container: root,
    motion: "reduced",
    preview: button,
    setPreviewSource: load,
    ensurePreviewReady: ensure,
  });
  await handoff.setPreviewSource("first");
  const ready = handoff.ensurePreviewReady();
  await handoff.setPreviewSource("second");
  release();
  await expect(ready).rejects.toThrow("fetch failed");
  expect(load.mock.calls).toEqual([["first"], ["second"]]);
  await handoff.ensurePreviewReady();
  expect(load.mock.calls).toEqual([["first"], ["second"], ["second"]]);
  expect(ensure).toHaveBeenCalledOnce();
  await handoff.setPreviewSource("last");
  handoff.dispose();
  await vi.waitFor(() => expect(load).toHaveBeenLastCalledWith("last"));
  expect(button.hidden).toBe(false);
  await handoff.setPreviewSource("disposed");
  expect(load).toHaveBeenCalledTimes(4);
});
