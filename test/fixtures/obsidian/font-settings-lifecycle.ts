import { afterEach, beforeEach, vi } from "vitest";
import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";

vi.mock("../../../src/obsidian/fonts/native-font-preview", async (original) => ({
  ...(await original<typeof import("../../../src/obsidian/fonts/native-font-preview")>()),
  loadNativeFontPreview: vi.fn(async () => undefined),
}));

export function installFontSettingsLifecycle(): void {
  beforeEach(installObsidianDomHelpers);
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });
}
