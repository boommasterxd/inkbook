// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Platform } from "obsidian";

import { createInkbookLockedPreview } from "../../../../src/obsidian/embeds/locked-preview";
import { createHtmlElement, installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

const SAFE_PREVIEW_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><metadata></metadata></svg>';

beforeEach(() => {
  installObsidianDomHelpers();
});

afterEach(() => {
  Platform.isAndroidApp = false;
  document.body.replaceChildren();
});

describe("locked preview platform treatment", () => {
  it("marks only Android activation buttons for host tap-surface neutralization", () => {
    Platform.isAndroidApp = true;
    const androidButton = createHtmlElement("button");
    createInkbookLockedPreview(androidButton, { aspectRatio: 1, safeSvg: SAFE_PREVIEW_SVG });

    Platform.isAndroidApp = false;
    const desktopButton = createHtmlElement("button");
    createInkbookLockedPreview(desktopButton, { aspectRatio: 1, safeSvg: SAFE_PREVIEW_SVG });

    expect(androidButton.classList.contains("inkbook-locked-preview-android")).toBe(true);
    expect(desktopButton.classList.contains("inkbook-locked-preview-android")).toBe(false);
  });
});
