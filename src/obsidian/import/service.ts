import { applyInkImport } from "./apply";
import { cleanupInkImport } from "./cleanup";
import { journalPath, MAX_JOURNAL_CHARS, readJournal, type ImportJournalStore } from "./journal";
import { verifyJournalEvidence } from "./journal-evidence";
import { reconcileJournal } from "./recovery";
import { scanInkImports } from "./scan";
import {
  INK_IMPORT_FOLDER,
  type InkImportJournal,
  type InkImportPorts,
  type InkImportPreview,
  type InkImportResult,
} from "./types";
import { undoInkImport } from "./undo";

function result(store: ImportJournalStore, signal?: AbortSignal): InkImportResult {
  const conflictingPaths = new Set(
    store.journal.notes.filter((note) => note.status === "conflict").map((note) => note.path),
  );
  return {
    journal: store.journal,
    imported: store.journal.sources.filter(
      (source) => source.status === "created" || source.status === "cleaned",
    ).length,
    conflicts:
      store.journal.issues.filter((issue) => {
        const separator = issue.lastIndexOf(": Undo ");
        return separator === -1 || !conflictingPaths.has(issue.slice(0, separator));
      }).length + conflictingPaths.size,
    cancelled: signal?.aborted === true || store.journal.status === "cancelled",
  };
}

export class ObsidianInkImportService {
  readonly #ports: InkImportPorts;
  #busy = false;

  constructor(ports: InkImportPorts) {
    this.#ports = ports;
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#busy) throw new Error("An Ink import operation is already running.");
    this.#busy = true;
    try {
      return await operation();
    } finally {
      this.#busy = false;
    }
  }

  scan(signal?: AbortSignal): Promise<InkImportPreview> {
    return this.#exclusive(() => scanInkImports(this.#ports, signal));
  }

  apply(preview: InkImportPreview, signal?: AbortSignal): Promise<InkImportResult> {
    return this.#exclusive(async () => {
      if (this.#ports.listFiles().some((file) => file.path === journalPath(preview.id))) {
        const existing = await readJournal(this.#ports, preview.id);
        await reconcileJournal(this.#ports, existing);
        return result(existing, signal);
      }
      return result(await applyInkImport(this.#ports, preview, signal), signal);
    });
  }

  history(signal?: AbortSignal): Promise<readonly InkImportJournal[]> {
    return this.#exclusive(async () => {
      const files = this.#ports
        .listFiles()
        .filter(
          (file) =>
            file.path.startsWith(`${INK_IMPORT_FOLDER}/`) && file.path.endsWith("/journal.json"),
        );
      if (files.length > 1000) throw new Error("Import history exceeds the safe run limit.");
      const journals: InkImportJournal[] = [];
      for (const file of files) {
        signal?.throwIfAborted();
        await this.#ports.workScheduler.checkpoint(signal, "background");
        const id = file.path.split("/")[1];
        if (id === undefined) continue;
        try {
          if (file.path !== journalPath(id)) continue;
          if (file.size > MAX_JOURNAL_CHARS)
            throw new Error("Journal exceeds the safe read limit.");
          const store = await readJournal(this.#ports, id);
          await reconcileJournal(this.#ports, store);
          journals.push(store.journal);
        } catch {
          signal?.throwIfAborted();
          journals.push({
            version: 1,
            id,
            createdAt: "",
            status: "conflict",
            sources: [],
            notes: [],
            issues: [
              "This import history is unreadable or inconsistent. Its vault files were preserved.",
            ],
            unreadable: true,
            issueDetails: [{ code: "historyUnreadable" }],
          });
        }
      }
      return journals.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    });
  }

  #mutateRun(
    id: string,
    operation: typeof undoInkImport,
    signal?: AbortSignal,
  ): Promise<InkImportResult> {
    return this.#exclusive(async () => {
      const store = await readJournal(this.#ports, id);
      await reconcileJournal(this.#ports, store);
      await verifyJournalEvidence(this.#ports, store.journal);
      await operation(this.#ports, store, signal);
      return result(store, signal);
    });
  }

  undo(id: string, signal?: AbortSignal): Promise<InkImportResult> {
    return this.#mutateRun(id, undoInkImport, signal);
  }

  cleanup(id: string, signal?: AbortSignal): Promise<InkImportResult> {
    return this.#mutateRun(id, cleanupInkImport, signal);
  }
}
