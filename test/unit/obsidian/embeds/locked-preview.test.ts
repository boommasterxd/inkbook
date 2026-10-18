// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActiveScenePreviewHandoff } from "../../../../src/obsidian/embeds/active-scene-handoff";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { createSnapshot } from "../../persistence/serialization/fixtures";
import { createConfirmedOutputFixture } from "../../../fixtures/obsidian/confirmed-output";

import { Platform, type Vault } from "obsidian";
import * as previewBuilder from "../../../../src/obsidian/embeds/safe-preview-builder";
import { ObsidianInkbookDocumentRecognition } from "../../../../src/obsidian/embeds/document-recognition";

import { createInkbookLockedPreview } from "../../../../src/obsidian/embeds/locked-preview";
import { createHtmlElement, installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { deferredPreviewRecognition } from "../../../fixtures/obsidian/deferred-preview-recognition";
import { immediateWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";

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
    const android = createInkbookLockedPreview(
      androidButton,
      {
        aspectRatio: 1,
        contentIdentity: CONTENT_IDENTITY,
        safeSvg: SAFE_PREVIEW_SVG,
      },
      immediateWorkScheduler(),
    );

    Platform.isAndroidApp = false;
    const desktopButton = createHtmlElement("button");
    const desktop = createInkbookLockedPreview(
      desktopButton,
      {
        aspectRatio: 1,
        contentIdentity: CONTENT_IDENTITY,
        safeSvg: SAFE_PREVIEW_SVG,
      },
      immediateWorkScheduler(),
    );

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
    workScheduler: immediateWorkScheduler(),
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
    const preview = createInkbookLockedPreview(
      button,
      {
        aspectRatio: 1,
        contentIdentity: CONTENT_IDENTITY,
        safeSvg: SAFE_PREVIEW_SVG,
      },
      immediateWorkScheduler(),
    );
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
  let ready: Promise<void> | undefined;
  for (const revision of [2, 3]) {
    preview.setDescriptor({
      aspectRatio: revision,
      contentIdentity: { ...CONTENT_IDENTITY, revision },
      safeSvg: SAFE_PREVIEW_SVG.replace("</svg>", `<path d="M0 0L${revision} ${revision}"/></svg>`),
    });
    ready ??= preview.ensureReady();
    await Promise.resolve();
  }
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
  const preview = createInkbookLockedPreview(
    button,
    {
      aspectRatio: 1,
      contentIdentity: CONTENT_IDENTITY,
      safeSvg: SAFE_PREVIEW_SVG,
    },
    immediateWorkScheduler(),
  );
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

it("cancels paused descriptor work when a hidden surface receives a newer revision", async () => {
  const { button, preview } = await preparedPreview();
  preview.setBackgroundWait(() => new Promise<void>(() => undefined));
  const builder = vi.spyOn(previewBuilder, "createPreviewSvgAsync");
  const creates = vi.spyOn(document, "createElementNS");
  preview.setDescriptor({
    aspectRatio: 2,
    contentIdentity: { ...CONTENT_IDENTITY, revision: 2 },
    safeSvg: SAFE_PREVIEW_SVG,
  });
  const obsolete = builder.mock.results[0]?.value as Promise<SVGSVGElement | undefined>;
  await Promise.resolve();
  button.hidden = true;
  preview.setDescriptor({
    aspectRatio: 3,
    contentIdentity: { ...CONTENT_IDENTITY, revision: 3 },
    safeSvg: SAFE_PREVIEW_SVG.replace("</svg>", '<path d="M0 0L3 3"/></svg>'),
  });
  await expect(obsolete).resolves.toBeUndefined();
  expect(creates).not.toHaveBeenCalled();
  expect(builder).toHaveBeenCalledOnce();
  preview.setBackgroundWait(undefined);
  await preview.ensureReady();
  expect(builder).toHaveBeenCalledTimes(2);
  expect(creates).toHaveBeenCalledTimes(2);
  expect(button.querySelector("path")).toBeNull();
  button.hidden = false;
  preview.refresh();
  expect(button.querySelector("path")?.getAttribute("d")).toBe("M0 0L3 3");
  preview.dispose();
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

it("shares validated Vault bytes across locked surfaces and builds independent SVG trees", async () => {
  const serialized = serializeInkbookDocument(createSnapshot());
  if (!serialized.ok) throw new Error("Invalid test snapshot");
  const { file, cachedRead, recognition, release } = deferredPreviewRecognition(
    "shared.svg",
    serialized.value.svg.length,
  );
  const sourceLoader = { documentId: file.path, documents: recognition };
  const first = createInkbookLockedPreview(
    createHtmlElement("button"),
    {
      aspectRatio: 1,
      contentIdentity: CONTENT_IDENTITY,
      safeSvg: SAFE_PREVIEW_SVG,
    },
    immediateWorkScheduler(),
    sourceLoader,
  );
  const second = createInkbookLockedPreview(
    createHtmlElement("button"),
    {
      aspectRatio: 1,
      contentIdentity: CONTENT_IDENTITY,
      safeSvg: SAFE_PREVIEW_SVG,
    },
    immediateWorkScheduler(),
    sourceLoader,
  );
  const source = `app://shared.svg?inkbook-revision=${String(serialized.value.snapshot.revision)}-${serialized.value.hash}`;
  const firstLoad = first.setSource(source);
  const secondLoad = second.setSource(source);
  await vi.waitFor(() => expect(cachedRead).toHaveBeenCalledOnce());
  first.dispose();
  release(serialized.value.svg);
  await expect(firstLoad).resolves.toBeUndefined();
  await expect(secondLoad).resolves.toEqual({
    outputHash: serialized.value.hash,
    revision: serialized.value.snapshot.revision,
  });
  await second.ensureReady();
  expect(second.element.querySelector("svg")).not.toBeNull();
  const third = createInkbookLockedPreview(
    createHtmlElement("button"),
    {
      aspectRatio: 1,
      contentIdentity: CONTENT_IDENTITY,
      safeSvg: SAFE_PREVIEW_SVG,
    },
    immediateWorkScheduler(),
    sourceLoader,
  );
  await third.setSource(source);
  await third.ensureReady();
  expect(cachedRead).toHaveBeenCalledOnce();
  expect(third.element.querySelector("svg")).not.toBe(second.element.querySelector("svg"));
  await expect(
    third.setSource(`app://shared.svg?inkbook-revision=999-${serialized.value.hash}`),
  ).rejects.toThrow("changed while loading");
  expect(cachedRead).toHaveBeenCalledOnce();
  expect(recognition.cached(file.path)).toMatchObject({
    contentIdentity: {
      outputHash: serialized.value.hash,
      revision: serialized.value.snapshot.revision,
    },
  });
  recognition.invalidate(file.path);
  const reloaded = third.setSource(source);
  await vi.waitFor(() => expect(cachedRead).toHaveBeenCalledTimes(2));
  release(serialized.value.svg);
  await expect(reloaded).resolves.toEqual({
    outputHash: serialized.value.hash,
    revision: serialized.value.snapshot.revision,
  });
  third.dispose();
  second.dispose();
  recognition.dispose();
});

it("uses confirmed safe bytes without reading again and rejects a mismatched revision", async () => {
  const { file, serialized, signature } = createConfirmedOutputFixture();
  const cachedRead = vi.fn(async () => serialized.value.svg);
  const recognition = new ObsidianInkbookDocumentRecognition(
    {
      getFileByPath: (path: string) => (path === file.path ? file : null),
      getResourcePath: () => "app://confirmed.svg",
      cachedRead,
    } as unknown as Vault,
    { workScheduler: immediateWorkScheduler() },
  );
  recognition.acceptConfirmedOutput(
    file.path,
    serialized.value.svg,
    serialized.value.hash,
    signature,
  );
  const preview = createInkbookLockedPreview(
    createHtmlElement("button"),
    { aspectRatio: 1, contentIdentity: CONTENT_IDENTITY, safeSvg: SAFE_PREVIEW_SVG },
    immediateWorkScheduler(),
    { documentId: file.path, documents: recognition },
  );
  const prefix = `app://confirmed.svg?inkbook-revision=`;
  await expect(
    preview.setSource(
      `${prefix}${String(serialized.value.snapshot.revision)}-${serialized.value.hash}`,
    ),
  ).resolves.toEqual({
    outputHash: serialized.value.hash,
    revision: serialized.value.snapshot.revision,
  });
  expect(cachedRead).not.toHaveBeenCalled();
  await expect(
    preview.setSource(
      `app://other.svg?inkbook-revision=${String(serialized.value.snapshot.revision)}-${serialized.value.hash}`,
    ),
  ).rejects.toThrow("does not match its file");
  expect(cachedRead).not.toHaveBeenCalled();
  await expect(preview.setSource(`${prefix}999-${serialized.value.hash}`)).rejects.toThrow(
    "changed while loading",
  );
  expect(cachedRead).not.toHaveBeenCalled();
  expect(recognition.cached(file.path)).toMatchObject({
    contentIdentity: {
      outputHash: serialized.value.hash,
      revision: serialized.value.snapshot.revision,
    },
  });
  preview.dispose();
  recognition.dispose();
});

it("prepares initial content asynchronously under the owning-window scheduler", async () => {
  const button = createHtmlElement("button");
  const shouldYield = vi.fn(() => false);
  const parser = vi.spyOn(window.DOMParser.prototype, "parseFromString");
  const creates = vi.spyOn(document, "createElementNS");
  const preview = createInkbookLockedPreview(
    button,
    {
      aspectRatio: 1,
      contentIdentity: CONTENT_IDENTITY,
      safeSvg: `<svg xmlns="http://www.w3.org/2000/svg">${'<path d="M0 0"/>'.repeat(64)}</svg>`,
    },
    immediateWorkScheduler(shouldYield),
  );
  expect(button.querySelector("svg")).toBeNull();
  expect(creates.mock.calls.some(([namespace]) => namespace === "http://www.w3.org/2000/svg")).toBe(
    false,
  );
  await preview.ensureReady();
  expect(button.querySelectorAll("path")).toHaveLength(64);
  expect(shouldYield).toHaveBeenCalled();
  expect(parser).not.toHaveBeenCalled();
  preview.dispose();
});

async function preparedPreview(hidden = false) {
  const button = createHtmlElement("button");
  const preview = createInkbookLockedPreview(
    button,
    {
      aspectRatio: 1,
      contentIdentity: CONTENT_IDENTITY,
      safeSvg: SAFE_PREVIEW_SVG,
    },
    immediateWorkScheduler(),
  );
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
    workScheduler: immediateWorkScheduler(),
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
