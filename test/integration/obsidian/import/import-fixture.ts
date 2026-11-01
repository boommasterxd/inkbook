import { ObsidianInkImportService } from "../../../../src/obsidian/import/service";
import type { InkImportPorts } from "../../../../src/obsidian/import/types";
import { immediateWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";

export function writingEmbed(path = "Ink/example.svg", description = "InkWriting"): string {
  return ` ![${description}](<${path}>) [Edit Writing](https://youtu.be/2arL1jh8ihA?type=inkWriting)`;
}

export async function appliedImportFixture() {
  const fixture = importFixture();
  const preview = await fixture.service.scan();
  const { journal } = await fixture.service.apply(preview);
  return {
    ...fixture,
    preview,
    journal,
    journalPath: `inkbook-imports/${preview.id}/journal.json`,
  };
}

export async function cleanedImportFixture() {
  const fixture = await appliedImportFixture();
  await fixture.service.cleanup(fixture.preview.id);
  return fixture;
}

export function importFixture(
  initial: Readonly<Record<string, string>> = {
    "Ink/example.svg": "writing source",
    "note.md": `Introduction\n\n${writingEmbed()}\n\nConclusion`,
  },
) {
  const files = new Map(Object.entries(initial));
  const writes: { readonly path: string; readonly content?: string; readonly kind: string }[] = [];
  const reads: string[] = [];
  const conversions: string[] = [];
  let run = 0;
  let fault: ((kind: string, path: string) => void) | undefined;
  const ports: InkImportPorts = {
    workScheduler: immediateWorkScheduler(),
    listFiles: () => [...files].map(([path, content]) => ({ path, size: content.length })),
    read: (path) => {
      reads.push(path);
      fault?.("read", path);
      const value = files.get(path);
      if (value === undefined) return Promise.reject(new Error("Missing file"));
      return Promise.resolve(value);
    },
    create: (path, content) => {
      fault?.("create", path);
      if (files.has(path)) return Promise.reject(new Error("File exists"));
      files.set(path, content);
      writes.push({ path, content, kind: "create" });
      fault?.("created", path);
      return Promise.resolve();
    },
    compareAndWrite: (path, expected, content) => {
      fault?.("write", path);
      if (files.get(path) !== expected) return Promise.resolve(false);
      files.set(path, content);
      writes.push({ path, content, kind: "write" });
      fault?.("written", path);
      return Promise.resolve(true);
    },
    trash: (path, expected) => {
      fault?.("trash", path);
      if (files.get(path) !== expected) return Promise.resolve(false);
      files.delete(path);
      writes.push({ path, kind: "trash" });
      fault?.("trashed", path);
      return Promise.resolve(true);
    },
    resolveLink: (path) => (files.has(path) ? path : undefined),
    generateEmbed: (path, _note, description) =>
      `!inkbook[[${path}${description === undefined || description === "InkWriting" ? "" : `|${description}`}]]`,
    referenceState: (path) =>
      Promise.resolve(
        [...files].some(
          ([name, text]) =>
            name.endsWith(".md") && !name.startsWith("inkbook-imports/") && text.includes(path),
        )
          ? "referenced"
          : "unreferenced",
      ),
    hash: async (value) => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    },
    convert: (value) => {
      conversions.push(value);
      return value === "invalid"
        ? Promise.reject(new Error("Invalid writing"))
        : Promise.resolve({
            svg: `<svg data-native="${value}"/>`,
            warnings: ["Pressure approximated"],
          });
    },
    createRunId: () => `run-${++run}`,
    now: () => "2026-10-29T12:00:00.000Z",
  };
  return {
    files,
    writes,
    reads,
    conversions,
    ports,
    service: new ObsidianInkImportService(ports),
    setFault: (next?: (kind: string, path: string) => void) => {
      fault = next;
    },
  };
}
