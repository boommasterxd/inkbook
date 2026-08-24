// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import {
  createPreviewSvg,
  validatePreviewSvg,
} from "../../../../src/obsidian/embeds/safe-preview-svg";
import { createSnapshot } from "../../persistence/serialization/fixtures";

describe("safe locked-preview SVG", () => {
  it("mounts only presentation paths after complete safe-envelope validation", async () => {
    const serialized = serializeInkbookDocument(createSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;

    const safeSvg = await validatePreviewSvg(serialized.value.svg);
    expect(safeSvg).toBe(serialized.value.svg);
    if (safeSvg === null) return;
    const preview = createPreviewSvg(document, safeSvg);

    expect(preview.classList.contains("inkbook-locked-preview-svg")).toBe(true);
    expect(preview.getAttribute("preserveAspectRatio")).toBe("none");
    expect(preview.querySelector("metadata")).toBeNull();
    expect(preview.querySelector("style")).toBeNull();
    expect(preview.querySelectorAll("path").length).toBeGreaterThan(0);
  });

  it("rejects executable or unknown markup before DOM parsing", async () => {
    const serialized = serializeInkbookDocument(createSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const unsafe = serialized.value.svg.replace(
      '<g id="inkbook-content">',
      '<script>bad()</script><g id="inkbook-content">',
    );

    await expect(validatePreviewSvg(unsafe)).resolves.toBeNull();
  });
});
