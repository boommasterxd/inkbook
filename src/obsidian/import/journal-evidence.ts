import { findMarkdownInkbookEmbeds } from "../embeds/markdown-embed";
import { applyImportPatches, withImportedContexts } from "./patches";
import { findInkCandidates } from "./references";
import { MAX_IMPORT_FILE_CHARS } from "./scan";
import type { InkImportJournal, InkImportPorts } from "./types";

function relativePath(path: string, notePath: string): string {
  const parts = notePath.split("/").slice(0, -1);
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}

interface EvidenceLinks {
  readonly paths: ReadonlySet<string>;
  readonly resolve: InkImportPorts["resolveLink"];
}

function matchesSource(link: string, path: string, note: string, links: EvidenceLinks): boolean {
  const resolved = links.resolve(link, note);
  if (resolved !== undefined && links.paths.has(path)) return resolved === path;
  return (
    link === path ||
    relativePath(link, note) === path ||
    (!link.includes("/") && path.split("/").pop() === link)
  );
}

export async function verifyJournalEvidence(
  ports: InkImportPorts,
  journal: InkImportJournal,
): Promise<void> {
  const sources = new Map(journal.sources.map((source) => [source.path, source]));
  const links: EvidenceLinks = {
    paths: new Set(ports.listFiles().map((file) => file.path)),
    resolve: ports.resolveLink.bind(ports),
  };
  for (const note of journal.notes) {
    await ports.workScheduler.checkpoint(undefined, "background");
    const original = await ports.read(note.backupPath);
    if (
      original.length > MAX_IMPORT_FILE_CHARS ||
      (await ports.hash(original)) !== note.originalHash
    ) {
      throw new Error("The original note backup changed; recovery stopped.");
    }
    for (const patch of note.patches) {
      const source = sources.get(patch.sourcePath);
      const candidates = await findInkCandidates(patch.before, ports.workScheduler);
      const candidate = candidates[0];
      if (
        source === undefined ||
        candidates.length !== 1 ||
        candidate === undefined ||
        candidate.start !== 0 ||
        candidate.original !== patch.before ||
        !matchesSource(candidate.link, source.path, note.path, links)
      ) {
        throw new Error("The journal does not describe an original writing reference.");
      }
      const after = findMarkdownInkbookEmbeds(patch.after)[0];
      if (
        after === undefined ||
        !matchesSource(after.linkpath, source.targetPath, note.path, links)
      ) {
        throw new Error("The journal replacement changed; recovery stopped.");
      }
    }
    const imported = applyImportPatches(original, note.patches);
    if ((await ports.hash(imported)) !== note.importedHash)
      throw new Error("The imported note evidence is inconsistent.");
    const contexts = withImportedContexts(imported, note.patches);
    if (
      contexts.some(
        (context, index) =>
          context.prefix !== note.patches[index]?.prefix ||
          context.suffix !== note.patches[index]?.suffix,
      )
    )
      throw new Error("The import replacement context is inconsistent.");
  }
}
