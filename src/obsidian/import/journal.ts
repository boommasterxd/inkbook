import { INK_IMPORT_FOLDER, type InkImportJournal, type InkImportPorts } from "./types";
import { findMarkdownInkbookEmbeds } from "../embeds/markdown-embed";

export const MAX_JOURNAL_CHARS = 16 * 1024 * 1024;

export function runFolder(id: string): string {
  if (!/^[a-z\d-]{1,100}$/iu.test(id)) throw new Error("Invalid import run identifier.");
  return `${INK_IMPORT_FOLDER}/${id}`;
}

export function journalPath(id: string): string {
  return `${runFolder(id)}/journal.json`;
}

export function safeImportPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !/[\0\r\n\\<>|]/u.test(value) &&
    !value.startsWith("/") &&
    !value.split("/").some((part) => part === ".." || part === "." || part === "")
  );
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSourceRecord(value: Record<string, unknown>): boolean {
  const path = value["path"];
  const target = value["targetPath"];
  return (
    typeof path === "string" &&
    /\.(?:svg|writing)$/iu.test(path) &&
    safeImportPath(target) &&
    target.endsWith(".svg") &&
    !target.startsWith(`${INK_IMPORT_FOLDER}/`) &&
    typeof value["hash"] === "string" &&
    typeof value["outputHash"] === "string" &&
    ["intent", "created", "conflict", "cleaned"].includes(String(value["status"])) &&
    Array.isArray(value["warnings"]) &&
    value["warnings"].every((item: unknown) => typeof item === "string")
  );
}

function validRecord(value: unknown, folder: string, source: boolean): boolean {
  if (
    !object(value) ||
    !safeImportPath(value["path"]) ||
    value["path"].startsWith(`${INK_IMPORT_FOLDER}/`) ||
    typeof value["backupPath"] !== "string" ||
    !safeImportPath(value["backupPath"]) ||
    !value["backupPath"].startsWith(`${folder}/`)
  )
    return false;
  if (source) return validSourceRecord(value);
  return (
    value["path"].endsWith(".md") &&
    typeof value["originalHash"] === "string" &&
    typeof value["importedHash"] === "string" &&
    ["intent", "applied", "undone", "conflict"].includes(String(value["status"])) &&
    Array.isArray(value["patches"]) &&
    value["patches"].length <= 10_000 &&
    value["patches"].every((patch: unknown) => validPatch(patch))
  );
}

function validPatch(value: unknown): boolean {
  if (
    !object(value) ||
    !safeImportPath(value["sourcePath"]) ||
    !Number.isSafeInteger(value["start"]) ||
    Number(value["start"]) < 0
  )
    return false;
  return (
    ["before", "after", "prefix", "suffix"].every(
      (key) => typeof value[key] === "string" && value[key].length <= 8192,
    ) &&
    String(value["before"]).length > 0 &&
    ["pending", "applied", "undone", "conflict"].includes(String(value["status"]))
  );
}

export function parseJournal(content: string, id: string): InkImportJournal {
  if (content.length > MAX_JOURNAL_CHARS)
    throw new Error("Import history exceeds the safe size limit.");
  const value: unknown = JSON.parse(content);
  if (
    !object(value) ||
    value["version"] !== 1 ||
    value["id"] !== id ||
    typeof value["createdAt"] !== "string" ||
    !["running", "complete", "cancelled", "undone", "conflict"].includes(String(value["status"])) ||
    !Array.isArray(value["sources"]) ||
    value["sources"].length > 1000 ||
    !value["sources"].every((item: unknown) => validRecord(item, runFolder(id), true)) ||
    !Array.isArray(value["notes"]) ||
    value["notes"].length > 10_000 ||
    !value["notes"].every((item: unknown) => validRecord(item, runFolder(id), false)) ||
    !Array.isArray(value["issues"]) ||
    !value["issues"].every((item: unknown) => typeof item === "string")
  ) {
    throw new Error("Import history is invalid; no vault files were changed.");
  }
  const journal = value as unknown as InkImportJournal;
  validateJournalRelations(journal);
  return journal;
}

function validateJournalRelations(journal: InkImportJournal): void {
  const sourcePaths = new Set<string>();
  journal.sources.forEach((source, index) => {
    const stem = source.path.replace(/\.[^./]+$/u, "");
    const suffix = source.targetPath.slice(stem.length);
    if (
      sourcePaths.has(source.path) ||
      !source.targetPath.startsWith(stem) ||
      !/^\.inkbook(?:-[1-9]\d*)?\.svg$/u.test(suffix) ||
      source.backupPath !== `${runFolder(journal.id)}/source-${index}.txt`
    ) {
      throw new Error("Import source history is inconsistent.");
    }
    sourcePaths.add(source.path);
  });
  journal.notes.forEach((note, index) => {
    if (note.backupPath !== `${runFolder(journal.id)}/note-${index}.md`)
      throw new Error("Import note backup is invalid.");
    for (const patch of note.patches) {
      const source = journal.sources.find((candidate) => candidate.path === patch.sourcePath);
      const parsed = findMarkdownInkbookEmbeds(patch.after);
      if (source === undefined || parsed.length !== 1 || parsed[0]?.markdown !== patch.after) {
        throw new Error("Import replacement history is inconsistent.");
      }
    }
  });
}

export class ImportJournalStore {
  readonly #ports: InkImportPorts;
  #saved: string | undefined;
  readonly journal: InkImportJournal;

  constructor(ports: InkImportPorts, journal: InkImportJournal, saved?: string) {
    this.#ports = ports;
    this.journal = journal;
    this.#saved = saved;
  }

  async save(): Promise<void> {
    const next = JSON.stringify(this.journal);
    if (next.length > MAX_JOURNAL_CHARS)
      throw new Error("Import history exceeds the safe size limit.");
    const path = journalPath(this.journal.id);
    if (this.#saved === undefined) await this.#ports.create(path, next);
    else if (!(await this.#ports.compareAndWrite(path, this.#saved, next))) {
      throw new Error("Import history changed externally; the operation stopped.");
    }
    if ((await this.#ports.read(path)) !== next) throw new Error("Import history readback failed.");
    this.#saved = next;
  }
}

export async function readJournal(ports: InkImportPorts, id: string): Promise<ImportJournalStore> {
  const content = await ports.read(journalPath(id));
  return new ImportJournalStore(ports, parseJournal(content, id), content);
}

export async function createVerified(
  ports: InkImportPorts,
  path: string,
  content: string,
): Promise<void> {
  await ports.create(path, content);
  if ((await ports.read(path)) !== content)
    throw new Error("Import backup or output readback failed.");
}
