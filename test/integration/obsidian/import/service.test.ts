import { expect, it } from "vitest";

import { ObsidianInkImportService } from "../../../../src/obsidian/import/service";
import type { InkImportPorts } from "../../../../src/obsidian/import/types";
import { convertObsidianInk } from "../../../../src/persistence/import/obsidian-ink/convert";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { sha256Hex } from "../../../../src/persistence/serialization/sha256";
import { immediateWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";
import { parseInkbookDocumentForTest } from "../../../fixtures/persistence/parse-document";
import {
  canvasSnapshot,
  canvasStroke,
  inkSvg,
} from "../../../unit/persistence/import/obsidian-ink/fixtures";

function vaultPorts(files: Map<string, string>): InkImportPorts {
  return {
    workScheduler: immediateWorkScheduler(),
    listFiles: () => [...files].map(([path, content]) => ({ path, size: content.length })),
    read: (path) => {
      const content = files.get(path);
      return content === undefined
        ? Promise.reject(new Error(`Missing vault file: ${path}`))
        : Promise.resolve(content);
    },
    create: (path, content) => {
      if (files.has(path)) return Promise.reject(new Error(`File already exists: ${path}`));
      files.set(path, content);
      return Promise.resolve();
    },
    compareAndWrite: (path, expected, content) => {
      if (files.get(path) !== expected) return Promise.resolve(false);
      files.set(path, content);
      return Promise.resolve(true);
    },
    trash: (path, expected) => Promise.resolve(files.get(path) === expected && files.delete(path)),
    resolveLink: (link) => (files.has(link) ? link : undefined),
    generateEmbed: (targetPath) => `![[${targetPath}]]`,
    referenceState: () => Promise.resolve("unknown"),
    hash: (content) => Promise.resolve(sha256Hex(new TextEncoder().encode(content))),
    convert: async (content, options) => {
      const converted = await convertObsidianInk(content, {
        legacyWriting: options.legacyWriting,
        signal: options.signal ?? new AbortController().signal,
        checkpoint: () => undefined,
        timestamp: 1234,
      });
      const serialized = serializeInkbookDocument(converted.snapshot);
      if (!serialized.ok) throw new Error(serialized.error.message);
      return {
        svg: serialized.value.svg,
        warnings: converted.warnings,
        warningCodes: converted.warningCodes,
      };
    },
    createRunId: () => "batch-1",
    now: () => "2026-01-01T00:00:00.000Z",
  };
}

it("imports a batch and restores its original links without overwriting later note edits", async () => {
  const firstReference = "![](first.svg) [Edit Writing](https://example.invalid/?type=inkWriting)";
  const secondReference =
    "![](second.svg) [Edit Writing](https://example.invalid/?type=inkWriting)";
  const before = new Map([
    ["first.svg", inkSvg(canvasSnapshot())],
    [
      "second.svg",
      inkSvg(canvasSnapshot({ strokes: [{ ...canvasStroke(), offset: { x: 40, y: 50 } }] })),
    ],
    ["first.md", `${firstReference}\n\n${"Original note paragraph. ".repeat(8)}`],
    ["second.md", secondReference],
  ]);
  const files = new Map(before);
  const ports = vaultPorts(files);
  const service = new ObsidianInkImportService(ports);
  const preview = await service.scan();
  expect(preview.sources.map(({ path }) => path).sort()).toEqual(["first.svg", "second.svg"]);
  expect(files).toEqual(before);

  const imported = await service.apply(preview);
  expect(imported).toMatchObject({ imported: 2, conflicts: 0, journal: { status: "complete" } });
  for (const source of imported.journal.sources) {
    const output = await ports.read(source.targetPath);
    expect(await parseInkbookDocumentForTest(output)).toMatchObject({
      ok: true,
      value: { snapshot: { elements: [{ kind: "stroke" }] } },
    });
    expect(files.get(source.path)).toBe(before.get(source.path));
    expect(files.get(source.backupPath)).toBe(before.get(source.path));
  }
  for (const note of imported.journal.notes)
    expect(files.get(note.backupPath)).toBe(before.get(note.path));
  expect(await ports.read("first.md")).toBe(
    before.get("first.md")?.replace(firstReference, "![[first.inkbook.svg]]"),
  );
  expect(files.get("second.md")).toBe("![[second.inkbook.svg]]");

  const laterEdit = "\n\nNew paragraph entered after import.";
  files.set("first.md", (await ports.read("first.md")) + laterEdit);
  const undone = await new ObsidianInkImportService(ports).undo(preview.id);
  expect(undone).toMatchObject({ conflicts: 0, journal: { status: "undone" } });
  expect(files.get("first.md")).toBe((before.get("first.md") ?? "") + laterEdit);
  expect(files.get("second.md")).toBe(before.get("second.md"));
});
