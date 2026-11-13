import { expect, it } from "vitest";
import { loadBuiltinFont } from "../../../../src/persistence/fonts/builtin-fonts";
import { AutosaveExportIntegrity } from "../../../../src/persistence/saving/autosave/export-integrity";
import { deriveDocumentIntegrityManifest } from "../../../../src/persistence/serialization/metadata/document-integrity-manifest";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/document-codec";
import { matchesCanonicalFontOutput } from "../../../../src/persistence/serialization/output/font-output-binding";
import { textElement } from "../../domain/schema/fixtures";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { createSnapshot } from "./fixtures";

it("independently rejects changed font payloads before autosave despite matching descriptor metadata", async () => {
  const font = await loadBuiltinFont("inter", 400, "normal", new TestWorkScheduler());
  const element = textElement();
  element.style.fontFamily = "inter";
  const snapshot = { ...createSnapshot([element]), version: 2 as const, fontResources: [font] };
  const saved = serializeInkbookDocument(snapshot);
  expect(saved.ok).toBe(true);
  if (!saved.ok) return;
  const manifest = deriveDocumentIntegrityManifest(snapshot);
  const integrity = new AutosaveExportIntegrity();
  const verify = (output?: string | Uint8Array) =>
    integrity.verify(
      () => snapshot,
      manifest,
      undefined,
      () => true,
      output,
    );
  expect(await verify(saved.value.svg)).toBe("match");
  expect(await verify(new TextEncoder().encode(saved.value.svg))).toBe("match");
  const changed = saved.value.svg.replace("base64,d09GM", "base64,A09GM");
  expect(changed).not.toBe(saved.value.svg);
  expect(await verify(changed)).toBe("retry-full");
  expect(await verify(changed)).toBe("fail");
  expect(await verify(saved.value.svg)).toBe("match");
  expect(await verify()).toBe("retry-full");
  expect(await matchesCanonicalFontOutput(saved.value.svg, [], () => undefined)).toBe(false);
  integrity.clear();
});
