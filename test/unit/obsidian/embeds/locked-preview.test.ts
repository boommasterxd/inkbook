// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActiveScenePreviewHandoff } from "../../../../src/obsidian/embeds/active-scene-handoff";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { createSnapshot } from "../../persistence/serialization/fixtures";

import { Platform } from "obsidian";

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
    createInkbookLockedPreview(androidButton, {
      aspectRatio: 1,
      contentIdentity: CONTENT_IDENTITY,
      safeSvg: SAFE_PREVIEW_SVG,
    });

    Platform.isAndroidApp = false;
    const desktopButton = createHtmlElement("button");
    createInkbookLockedPreview(desktopButton, {
      aspectRatio: 1,
      contentIdentity: CONTENT_IDENTITY,
      safeSvg: SAFE_PREVIEW_SVG,
    });

    expect(androidButton.classList.contains("inkbook-locked-preview-android")).toBe(true);
    expect(desktopButton.classList.contains("inkbook-locked-preview-android")).toBe(false);
  });
});

it("restores the latest deferred content before the preview handoff completes", () => {
  const button = createHtmlElement("button");
  const preview = createInkbookLockedPreview(button, {
    aspectRatio: 1,
    contentIdentity: CONTENT_IDENTITY,
    safeSvg: SAFE_PREVIEW_SVG,
  });
  button.hidden = true;
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
    const button = createHtmlElement("button");
    const preview = createInkbookLockedPreview(button, {
      aspectRatio: 1,
      contentIdentity: CONTENT_IDENTITY,
      safeSvg: SAFE_PREVIEW_SVG,
    });
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
    expect(parser).toHaveBeenCalledTimes(hidden ? 1 : 2);
    button.hidden = false;
    preview.refresh();
    expect(parser).toHaveBeenCalledTimes(2);
    const current = button.querySelector("svg");
    fetch.mockResolvedValue(new Response("<svg/>"));
    await expect(preview.setSource("app://unsafe.svg")).rejects.toThrow("not safe SVG");
    expect(button.querySelector("svg")).toBe(current);
    expect(parser).toHaveBeenCalledTimes(2);
    preview.dispose();
  },
);
