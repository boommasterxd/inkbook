import type { App } from "obsidian";
import { describe, expect, it } from "vitest";

import { createBuiltInSettings } from "../../../../src/domain/settings";
import { validateDocumentOutput } from "../../../../src/obsidian/commands/document-output-validation";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";

function fallbackApp(): App {
  const ownerWindow = {
    crypto: { getRandomValues: (bytes: Uint8Array) => bytes.fill(7) },
  } as unknown as Window;
  return {
    workspace: {
      getActiveViewOfType: () => ({
        containerEl: { ownerDocument: { defaultView: ownerWindow } },
      }),
    },
  } as unknown as App;
}

function validDocument(): string {
  const settings = createBuiltInSettings();
  const serialized = serializeInkbookDocument({
    elements: [],
    format: "inkbook",
    page: {
      activeBufferLines: settings.pageDefaults.activeBufferLines,
      background: { type: "none" },
      innerWidth: 2000,
      lockedBufferLines: settings.pageDefaults.lockedBufferLines,
      margin: 24.3,
    },
    revision: 0,
    version: 1,
  });
  if (!serialized.ok) throw new Error(serialized.error.message);
  return serialized.value.svg;
}

describe("created document validation", () => {
  it("validates complete read-back output through the bounded fallback", async () => {
    await expect(validateDocumentOutput(fallbackApp(), validDocument())).resolves.toBe(true);
  });

  it("rejects corrupted read-back output through the bounded fallback", async () => {
    await expect(validateDocumentOutput(fallbackApp(), "<svg />")).resolves.toBe(false);
  });
});
